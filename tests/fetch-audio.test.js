const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { once } = require("events");
const { hasAudio, covers, sourceDuration, probeAudio } = require("../tools/audio-coverage");
const { runQueue, lockedFetch, sections, config, fetchOne } = require("../tools/fetch-heldout-audio");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-audio-"));
  try {
    const c = { audioDir: dir, fixturesDir: dir, ledger: path.join(dir, "retry.json"), sleep: 0 };
    assert.strictEqual(config({ FETCH_AUDIO_IDS: path.join(dir, "ids") }).ledger, path.join(dir, "ids.audio-retries.json"));
    assert.deepStrictEqual([config({ FETCH_AUDIO_IDS: path.join(dir, "ids") }).sleep, config({}).sleepRequests], [10000, "4"]);
    fs.mkdirSync(path.join(dir, "shard"));
    fs.writeFileSync(path.join(dir, "shard.pacing.json"), JSON.stringify({ sleep: 3, sleepRequests: 1.5 }));
    const paced = config({ FETCH_AUDIO_IDS: path.join(dir, "shard", "chunk.txt"), HELDOUT_SLEEP: "5" });
    assert.deepStrictEqual([paced.sleep, paced.sleepRequests], [3000, "1.5"], "per-list pacing file overrides env");
    fs.writeFileSync(path.join(dir, "video_auto.en.json3"), JSON.stringify({ events: [
      { tStartMs: 40000, segs: [{ utf8: "[ __ ]" }, { utf8: "[__]", tOffsetMs: 1000 }] }
    ] }));
    assert.deepStrictEqual(sections("video", dir), [[5, 71]]);
    fs.writeFileSync(path.join(dir, "windows.json"), JSON.stringify({ video: [[25, 46]] }));
    assert.deepStrictEqual(config({ FETCH_AUDIO_WINDOWS: path.join(dir, "windows.json") }).windows.video, [[25, 46]]);
    assert.strictEqual(fetchOne({ ...c, windows: { video: [[25, 46]] } }, "nowindows"), 20, "no windows: never fetched whole");
    const attempts = [], pauses = [];
    const result = await runQueue(c, ["retry", "permanent", "present"], (_, id) => {
      attempts.push(id);
      return id === "permanent" ? 20 : id === "present" ? 0 : attempts.filter((x) => x === id).length < 3 ? 1 : 10;
    }, async (ms) => pauses.push(ms));
    assert.strictEqual(result, 1, "unresolved permanent failure must exit nonzero");
    assert.strictEqual(attempts.filter((id) => id === "retry").length, 3);
    assert.strictEqual(attempts.filter((id) => id === "permanent").length, 1);
    assert.ok(pauses.includes(30000) && pauses.includes(60000));
    let ledger = JSON.parse(fs.readFileSync(c.ledger));
    assert.deepStrictEqual(Object.keys(ledger.failures), ["permanent"]);
    assert.strictEqual(ledger.failures.permanent.permanent, true);
    await runQueue(c, ["permanent"], () => { throw new Error("must not retry known permanent failure"); });
    assert.strictEqual(await runQueue(c, ["bad"], () => 1, async () => {}), 1);
    ledger = JSON.parse(fs.readFileSync(c.ledger));
    assert.strictEqual(ledger.failures.bad.attempts, 3);
    assert.strictEqual(await runQueue(c, ["bad"], () => 10, async () => {}), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(c.ledger)).failures, {});
    assert.strictEqual(await runQueue(c, ["busy"], () => 75, async () => {}), 1);
    assert.match(JSON.parse(fs.readFileSync(c.ledger)).failures.busy.reason, /busy/i);
    // Two lanes wait with one item left. A later rate limit extends the shared deadline.
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const started = [], requests = new Map(), waits = [];
      const tick = () => new Promise(resolve => setImmediate(resolve));
      const running = runQueue({ ...c, parallel: 2 }, ["first", "second", "last"], (_, id) => {
        started.push([id, now]);
        if (id === "first" || id === "second") return new Promise(resolve => requests.set(id, resolve));
        return 10;
      }, ms => ms === 0 ? Promise.resolve() : new Promise(resolve => waits.push(resolve)));
      const limited = { status: 20, reason: "HTTP Error 429" };
      assert.deepStrictEqual(started, [["first", 0], ["second", 0]]);
      requests.get("first")(limited);
      await tick();
      now = 1000;
      requests.get("second")(limited);
      await tick();
      now = 120000;
      waits.shift()();
      await tick();
      assert.strictEqual(started.length, 2, "the extended pause still applies");
      now = 121000;
      waits.splice(0).forEach(resolve => resolve());
      assert.strictEqual(await running, 1);
      assert.deepStrictEqual(started, [["first", 0], ["second", 0], ["last", 121000]]);
    } finally { Date.now = realNow; }

    const geo = "The uploader has not made this video available in your country";
    fs.writeFileSync(c.ledger, JSON.stringify({ failures: { video: { permanent: true, reason: geo } } }));
    assert.strictEqual(await runQueue({ ...c, netns: "allowed" }, ["video"], (_, id) => {
      assert.strictEqual(id, "video");
      return 0;
    }, async () => {}), 0, "an old geographic failure must be reevaluated");

    if (spawnSync("flock", ["--version"]).status === 0) {
      fs.mkdirSync(path.join(dir, ".locks"));
      const id = "abcdefghijk", lock = path.join(dir, ".locks", id);
      const holder = spawn("flock", ["--no-fork", lock, process.execPath, "-e", 'console.log("locked"); setInterval(()=>{},1000)']);
      try {
        await once(holder.stdout, "data");
        assert.strictEqual((await lockedFetch(c, id)).status, 75, "another queue must not write a locked video");
      } finally {
        holder.kill("SIGKILL");
        await once(holder, "exit");
      }
      assert.strictEqual(spawnSync("flock", ["-n", lock, process.execPath, "-e", ""]).status, 0,
        "kernel must release the lock after a crash without deleting a stale lock file");
    }

    if (spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0) {
      const full = path.join(dir, "video.webm"), part = path.join(dir, "video.s5-12.webm");
      const ffmpeg = (...args) => assert.strictEqual(spawnSync("ffmpeg", ["-v", "error", "-y", ...args]).status, 0);
      ffmpeg("-f", "lavfi", "-i", "sine=duration=20", "-c:a", "libopus", full);
      ffmpeg("-ss", "5", "-to", "12", "-i", full, "-c", "copy", "-copyts", part);
      fs.renameSync(full, path.join(dir, "reference.webm"));
      assert.strictEqual(hasAudio(dir, "video", [[5, 12]]), true);
      assert.strictEqual(hasAudio(dir, "video", [[5, 15]]), false, "same start but shorter end is incomplete");
      assert.strictEqual(hasAudio(dir, "video", [[5, 12], [15, 20]]), false);
      assert.strictEqual(hasAudio(dir, "video", null), false, "whole-file completion needs source duration");
      assert.strictEqual(covers(part, 10, 15), false);
      fs.writeFileSync(path.join(dir, "video.source.json"), JSON.stringify({ videoId: "other", duration: 12 }));
      assert.strictEqual(sourceDuration(dir, "video"), null);
      assert.strictEqual(covers(part, 10, 15, sourceDuration(dir, "video")), false);
      fs.writeFileSync(path.join(dir, "video.source.json"), JSON.stringify({ videoId: "video", duration: 12 }));
      assert.strictEqual(hasAudio(dir, "video", [[5, 15]]), true, "proven video end permits clamping");
      assert.strictEqual(covers(part, 13, 15, 12), false);
      assert.ok(probeAudio(part));
      fs.writeFileSync(part, "corrupt media");
      assert.strictEqual(probeAudio(part), null, "cached validation must invalidate on file replacement");
      assert.strictEqual(hasAudio(dir, "video", [[5, 12]]), false);
      fs.copyFileSync(path.join(dir, "reference.webm"), full);
      fs.writeFileSync(path.join(dir, "video.source.json"), JSON.stringify({ videoId: "video", duration: 20 }));
      assert.strictEqual(hasAudio(dir, "video", null), true);
      fs.truncateSync(full, 0);
      assert.strictEqual(hasAudio(dir, "video", null), false);
      fs.copyFileSync(path.join(dir, "reference.webm"), full);
      const pathEnv = process.env.PATH;
      process.env.PATH = "";
      try { assert.throws(() => probeAudio(full), /Audio probe unavailable/, "missing tools must not read as invalid media"); }
      finally { process.env.PATH = pathEnv; }

      // Exercise the real parent -> flock -> child -> mocked yt-dlp path, without network.
      if (spawnSync("flock", ["--version"]).status === 0) {
        const id = "abcdefghijk", bin = path.join(dir, "bin"), audio = path.join(dir, "audio");
        fs.mkdirSync(bin);
        fs.mkdirSync(audio);
        const ids = path.join(dir, "ids.txt"), calls = path.join(dir, "calls.txt");
        fs.writeFileSync(ids, id + "\n");
        fs.writeFileSync(path.join(dir, `${id}_auto.en.json3`), JSON.stringify({ events: [
          { tStartMs: 5000, segs: [{ utf8: "[__]" }] }
        ] }));
        const invalid = path.join(audio, `${id}.s0-35.webm`);
        fs.writeFileSync(invalid, "invalid existing media");
        fs.writeFileSync(path.join(bin, "yt-dlp"), `#!${process.execPath}\n` +
          `const fs=require('fs'); const args=process.argv.slice(2);\n` +
          `fs.appendFileSync(${JSON.stringify(calls)},'call\\n');\n` +
          `if(args.includes('--dump-single-json')) console.log(JSON.stringify({id:'${id}',duration:20}));\n` +
          `else fs.copyFileSync(${JSON.stringify(path.join(dir, "reference.webm"))}, args[args.indexOf('-o')+1].replace('%(section_start)d','0').replace('%(section_end)d','20').replace('%(ext)s','webm'));\n`, { mode: 0o755 });
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FETCH_AUDIO_IDS: ids,
          FETCH_AUDIO_DIR: audio, FETCH_FIXTURES_DIR: dir, FETCH_AUDIO_LEDGER: path.join(dir, "integration-retries.json"),
          HELDOUT_NETNS: "direct", HELDOUT_SLEEP: "0", FETCH_AUDIO_METHOD: "sections" };
        const cli = () => spawnSync(process.execPath, [path.resolve(__dirname, "../tools/fetch-heldout-audio.js")],
          { env, encoding: "utf8", timeout: 15000 });
        let result = cli();
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
        assert.strictEqual(fs.existsSync(invalid), false, "invalid output must be replaced, not skipped by no-overwrites");
        assert.strictEqual(hasAudio(audio, id, [[0, 35]]), true);
        assert.strictEqual(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
        result = cli();
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
        assert.strictEqual(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2, "validated audio needs no new network request");
        // An exit-zero download with corrupt output still fails post-download validation.
        fs.unlinkSync(path.join(audio, `${id}.s0-20.webm`));
        fs.writeFileSync(path.join(bin, "yt-dlp"), `#!${process.execPath}\n` +
          `const fs=require('fs'); const args=process.argv.slice(2);\n` +
          `if(args.includes('--dump-single-json')) console.log(JSON.stringify({id:'${id}',duration:20}));\n` +
          `else fs.writeFileSync(args[args.indexOf('-o')+1].replace('%(section_start)d','0').replace('%(section_end)d','20').replace('%(ext)s','webm'), 'broken');\n`, { mode: 0o755 });
        result = spawnSync(process.execPath, [path.resolve(__dirname, "../tools/fetch-heldout-audio.js"), "--one-id", id],
          { env, encoding: "utf8", timeout: 15000 });
        assert.strictEqual(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /does not cover all required windows/);
        fs.writeFileSync(path.join(bin, "yt-dlp"), `#!${process.execPath}\nconsole.error(${JSON.stringify(geo)}); process.exit(1);\n`,
          { mode: 0o755 });
        result = cli();
        assert.strictEqual(result.status, 1, result.stdout + result.stderr);
        const restricted = JSON.parse(fs.readFileSync(env.FETCH_AUDIO_LEDGER)).failures[id];
        assert.strictEqual(restricted.permanent, false);
        assert.strictEqual(restricted.route, "direct");
        assert.strictEqual(restricted.attempts, 1, "a country block is not retried on the same run");

        // Confirmed unavailable sources are persisted, fail the queue, and are not retried forever.
        fs.writeFileSync(path.join(bin, "yt-dlp"), `#!${process.execPath}\n` +
          `require('fs').appendFileSync(${JSON.stringify(calls)},'call\\n'); console.error('Private video'); process.exit(1);\n`, { mode: 0o755 });
        result = cli();
        assert.strictEqual(result.status, 1, result.stdout + result.stderr);
        const permanent = JSON.parse(fs.readFileSync(env.FETCH_AUDIO_LEDGER)).failures[id];
        assert.strictEqual(permanent.permanent, true);
        assert.match(permanent.reason, /Private video/);
        const before = fs.readFileSync(calls, "utf8");
        result = cli();
        assert.strictEqual(result.status, 1);
        assert.strictEqual(fs.readFileSync(calls, "utf8"), before);

        // Whole-file mode (default): one whole-track download, local cuts in final form, temp removed.
        const whole = path.join(audio, ".whole"), log = path.join(dir, "whole-calls.txt");
        const mock = (filesize, wholeBody, duration = 20, sectionRef = path.join(dir, "reference.webm")) => fs.writeFileSync(path.join(bin, "yt-dlp"), `#!${process.execPath}\n` +
          `const fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');\n` +
          `const out=args[args.indexOf('-o')+1], ref=${JSON.stringify(path.join(dir, "reference.webm"))};\n` +
          `if(args.includes('--dump-single-json')) console.log(JSON.stringify({id:'${id}',duration:${duration},filesize:${filesize}}));\n` +
          `else if(args.includes('--download-sections')) fs.copyFileSync(${JSON.stringify(sectionRef)}, out.replace('%(section_start)d','0').replace('%(section_end)d','20').replace('%(ext)s','webm'));\n` +
          `else ${wholeBody};\n`, { mode: 0o755 });
        const wholeRun = (extra = {}) => {
          for (const name of fs.readdirSync(audio)) if (name.startsWith(`${id}.`)) fs.rmSync(path.join(audio, name));
          fs.rmSync(log, { force: true });
          const run = spawnSync(process.execPath, [path.resolve(__dirname, "../tools/fetch-heldout-audio.js"), "--one-id", id],
            { env: { ...env, FETCH_AUDIO_METHOD: "", FETCH_AUDIO_WHOLE_MAX_MB: "1", ...extra }, encoding: "utf8", timeout: 15000 }); // small cap: free-space check needs cap + 5 GB
          return { ...run, calls: fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
        };
        mock(1000, "fs.copyFileSync(ref, out)");
        result = wholeRun();
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.strictEqual(result.calls.length, 2);
        assert.ok(result.calls[1].includes("--max-filesize") && !result.calls[1].includes("--download-sections"), JSON.stringify(result.calls));
        assert.deepStrictEqual(fs.readdirSync(whole), [], "the whole track is deleted after cutting");
        const clip = path.join(audio, `${id}.s0-35.webm`);
        assert.strictEqual(hasAudio(audio, id, [[0, 35]]), true);
        assert.match(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels", "-of", "csv=p=0", clip],
          { encoding: "utf8" }).stdout.trim(), /^opus,1$/, "clips are cut straight into the compacted form");
        // Reusing the fetched metadata: no second page extraction for the whole track.
        result = wholeRun({ FETCH_AUDIO_REUSE_INFO: "1" });
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.ok(result.calls[1].includes("--load-info-json") && !result.calls[1].some((arg) => arg.includes("watch?v=")));
        assert.deepStrictEqual(fs.readdirSync(whole), [], "the info file is removed with the whole track");
        // A track ending 0.4 s before the reported duration proves the real source end.
        mock(1000, "fs.copyFileSync(ref, out)", 20.4);
        result = wholeRun();
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.ok(Math.abs(sourceDuration(audio, id) - 20) < 0.05, "source end clamped to the decoded track");
        // A broken whole track falls back to per-window sections and leaves nothing behind.
        mock(1000, "fs.writeFileSync(out, 'broken')");
        result = wholeRun();
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.match(result.stderr, /fetching missing windows per window: cuts failed: .*ffmpeg/);
        assert.ok(result.calls[2].includes("--download-sections"));
        assert.deepStrictEqual(fs.readdirSync(whole), []);
        assert.strictEqual(hasAudio(audio, id, [[0, 35]]), true);
        // HTTP 403 on the whole track: one fresh retry before any per-window fallback.
        const once = path.join(dir, "403-once");
        mock(1000, `if(!fs.existsSync(${JSON.stringify(once)})){fs.writeFileSync(${JSON.stringify(once)},'');console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden');process.exit(1)} else fs.copyFileSync(ref, out)`);
        result = wholeRun();
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.match(result.stderr, /HTTP 403; retrying once/);
        assert.deepStrictEqual(result.calls.map((args) => args.includes("--download-sections")), [false, false, false]);
        // One window that cannot be cut (track ends 10 s early): keep the good cut, fetch only that window.
        const long = path.join(dir, "reference30.webm"), win = path.join(dir, "two-windows.json");
        ffmpeg("-f", "lavfi", "-i", "sine=duration=30", "-c:a", "libopus", long);
        fs.writeFileSync(win, JSON.stringify({ [id]: [[0, 8], [12, 25]] }));
        mock(1000, "fs.copyFileSync(ref, out)", 30, long);
        result = wholeRun({ FETCH_AUDIO_WINDOWS: win });
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.match(result.stderr, /s12-25\.webm: media .* vs window 12-25, source end 30/);
        assert.deepStrictEqual(result.calls[2].filter((arg) => arg.startsWith("*")), ["*12-25"]);
        assert.ok(fs.existsSync(path.join(audio, `${id}.s0-8.webm`)), "valid whole-file cuts are kept");
        // A track known to exceed the size limit is never downloaded whole.
        mock(2e9, "process.exit(1)");
        result = wholeRun();
        assert.strictEqual(result.status, 10, result.stdout + result.stderr);
        assert.deepStrictEqual(result.calls.map((args) => args.includes("--download-sections")), [false, true]);
      }
    } else console.log("fetch-audio media checks skipped: ffmpeg/ffprobe unavailable");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log("fetch-audio.test.js passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
