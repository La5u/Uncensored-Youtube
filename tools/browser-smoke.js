const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const headless = args.includes("--headless");
const firefoxOnly = args.includes("--firefox-only");
const chromiumOnly = args.includes("--chromium-only");
const directNavigation = args.includes("--direct");
const playUntil = Number((args.find((arg) => arg.startsWith("--until=")) || "").split("=")[1]) || 0;
const pauseFor = Number((args.find((arg) => arg.startsWith("--pause=")) || "").split("=")[1]) || 0;
const urls = args.filter((arg) => /^https:\/\//.test(arg));
const firstUrl = urls[0] || "https://www.youtube.com/watch?v=kTeQSzHGWyw&t=9s";
const nextUrls = urls.slice(1);
if (!nextUrls.length) nextUrls.push("https://www.youtube.com/watch?v=an5iFYcjWUM");
const firstSeekTime = Number.parseFloat(new URL(firstUrl).searchParams.get("t")) || 0;
const launchUrl = new URL(firstUrl);
const playlistMode = launchUrl.searchParams.has("list");
if (firstSeekTime) launchUrl.searchParams.delete("t");
let secondId = "";
const chromiumPort = 12000 + process.pid % 1000;
const firefoxPort = 14000 + process.pid % 1000;
const children = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodedThrough(logs) {
  return Math.max(...logs.map((line) => {
    const match = line.match(/audio decoded (\d+):(\d+)/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  }));
}

async function retry(callback, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    await wait(250);
  }
  throw error || new Error("Browser did not become ready.");
}

function portReady(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

function launch(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => {
    const text = String(data);
    if (text.includes("[uncensored]") || text.includes("Extension ID")) process.stderr.write(text);
  });
  return child;
}

function socketClient(url, onEvent) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.type === "error" ? request.reject(new Error(message.message)) : request.resolve(message.result);
    } else if (onEvent) {
      onEvent(message);
    }
  };
  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    }),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out.`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
      });
    }
  };
}

function playbackExpression(resetCaptions = false) {
  return `(() => {
    localStorage.setItem("uncensoredDebug", "1");
    const player = document.querySelector("#movie_player");
    const automatic = player?.getOption?.("captions", "tracklist")?.find(track => track.languageCode === "en" && track.kind === "asr");
    if (automatic) player.setOption("captions", "track", automatic);
    const captions = document.querySelector(".ytp-subtitles-button");
    if (${resetCaptions} && captions && captions.getAttribute("aria-pressed") === "true") captions.click();
    if (captions && captions.getAttribute("aria-pressed") !== "true") captions.click();
    if (${resetCaptions} && captions) setTimeout(() => {
      if (captions.getAttribute("aria-pressed") !== "true") captions.click();
    }, 750);
    document.querySelector(".ytp-skip-ad-button")?.click();
    const video = document.querySelector("video");
    if (video) { video.muted = true; video.playbackRate = 2; video.play().catch(() => {}); }
    return { hook: typeof globalThis.__uncensoredDebugAudio === "function", url: location.href };
  })()`;
}

function searchExpression() {
  return `(() => {
    const id = ${JSON.stringify(secondId)};
    const input = document.querySelector('input[name="search_query"], #search-input input, ytd-searchbox input');
    const button = document.querySelector('button[aria-label="Search"], #search-icon-legacy');
    if (!input || !button) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, id);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    button.click();
    return true;
  })()`;
}

function watchExpression() {
  return `(() => {
    const id = ${JSON.stringify(secondId)};
    if (new URL(location.href).searchParams.get("v") === id) return true;
    const player = document.querySelector("#movie_player");
    if (!player) return false;
    if (${playlistMode}) {
      const next = document.querySelector('ytd-playlist-panel-video-renderer a[href*="v=' + id + '"]') ||
        document.querySelector(".ytp-next-button");
      if (!next) return false;
      next.click();
      if (typeof player.nextVideo === "function") player.nextVideo();
      return false;
    }
    {
      const selector = ${directNavigation}
        ? 'ytd-compact-video-renderer a[href*="/watch?v="], ytd-rich-item-renderer a[href*="/watch?v="]'
        : 'a[href*="/watch?v="]';
      const link = [...document.querySelectorAll(selector)]
        .find(anchor => new URL(anchor.href).searchParams.get("v") === id);
      if (!link) return false;
      link.click();
      return true;
    }
  })()`;
}

async function chromium() {
  const profile = `/tmp/uncensored-chromium-smoke-${process.pid}`;
  const extensionPaths = [path.join(root, "dist/chromium")];
  const ublockRoot = path.join(os.homedir(), ".config/chromium/Default/Extensions/ddkjiahejlhfcafbddmgiahcphecmpfh");
  if (fs.existsSync(ublockRoot)) {
    const versions = fs.readdirSync(ublockRoot).sort();
    if (versions.length) extensionPaths.push(path.join(ublockRoot, versions.at(-1)));
  }
  fs.rmSync(profile, { recursive: true, force: true });
  launch("chromium", [
    `--remote-debugging-port=${chromiumPort}`, `--user-data-dir=${profile}`,
    `--load-extension=${extensionPaths.join(",")}`,
    `--disable-extensions-except=${extensionPaths.join(",")}`,
    "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...(headless ? ["--headless=new"] : []),
    "--window-position=-2000,0", "--window-size=1280,900", "about:blank"
  ]);
  const target = await retry(async () => {
    const pages = await fetch(`http://127.0.0.1:${chromiumPort}/json/list`).then((response) => response.json());
    return pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl);
  });
  const logs = [];
  const client = socketClient(target.webSocketDebuggerUrl, (message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const line = (message.params.args || []).map((arg) => arg.value || arg.description || "").join(" ");
      if (line.includes("[uncensored]")) {
        logs.push(line);
        if (verbose) console.log(line);
      }
    }
  });
  await client.ready;
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Page.navigate", { url: launchUrl.href });
  if (!firstSeekTime) await wait(10000);
  let result = await retry(async () => {
    const response = await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
    return response.result.value.hook && response;
  });
  if (firstSeekTime) {
    await retry(async () => {
      const sought = await client.send("Runtime.evaluate", { expression: `(() => {
        const video = document.querySelector("video");
        const player = document.querySelector("#movie_player");
        if (video) video.pause();
        if (!video || !player?.seekTo || !(video.duration > ${firstSeekTime})) return false;
        player.seekTo(${firstSeekTime}, true);
        video.playbackRate = 1;
        video.play().catch(() => {});
        setTimeout(() => player.pauseVideo(), 250);
        return true;
      })()`, returnByValue: true });
      if (!sought.result.value) return false;
      await wait(500);
      const time = await client.send("Runtime.evaluate", {
        expression: "document.querySelector('video')?.currentTime", returnByValue: true
      });
      return Math.abs(time.result.value - firstSeekTime) < 2;
    });
  }
  try {
    await retry(async () => {
      if (logs.some((line) => line.includes("audio decoded"))) return true;
      const state = await client.send("Runtime.evaluate", {
        expression: "globalThis.__uncensoredDebugAudio?.().audioNeeded", returnByValue: true
      });
      if (state.result.value === false) return true;
      if (!firstSeekTime) {
        await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
      }
      return false;
    }, 90000);
  } catch (error) {
    const state = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({time: document.querySelector("video")?.currentTime,
        paused: document.querySelector("video")?.paused,
        captions: document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed"),
        audio: globalThis.__uncensoredDebugAudio?.()})`, returnByValue: true
    });
    throw new Error(`No initial Chromium audio or clean-caption decision. State: ${state.result.value}`);
  }
  if (pauseFor) {
    await client.send("Runtime.evaluate", { expression: "document.querySelector('video')?.pause()" });
    await wait(pauseFor * 1000);
    const checkpoint = logs.length;
    await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
    await retry(async () => {
      if (logs.slice(checkpoint).some((line) => line.includes("audio decoded"))) return true;
      const state = await client.send("Runtime.evaluate", {
        expression: "globalThis.__uncensoredDebugAudio?.().audioNeeded", returnByValue: true
      });
      if (state.result.value === false) return true;
      await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
      return false;
    }, 90000);
    console.log(`Chromium pause/resume smoke passed (${pauseFor}s).`);
  }
  if (playUntil) {
    await retry(async () => {
      const state = await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
      const time = await client.send("Runtime.evaluate", {
        expression: "document.querySelector('video')?.currentTime", returnByValue: true
      });
      return state.result.value.hook && time.result.value >= playUntil;
    }, (playUntil + 60) * 1000);
    const decoded = decodedThrough(logs);
    const state = await client.send("Runtime.evaluate", {
      expression: "globalThis.__uncensoredDebugAudio?.().audioNeeded", returnByValue: true
    });
    if (state.result.value !== false && decoded < playUntil - 20) {
      throw new Error(`Audio stopped at ${decoded}s.`);
    }
  }
  if (verbose && firstSeekTime) {
    await wait(5000);
    const captions = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({time: document.querySelector("video")?.currentTime,
        captions: [...document.querySelectorAll(".ytp-caption-segment")].map(node => node.textContent)})`,
      returnByValue: true
    });
    console.log(`Visible captions at ${firstSeekTime}: ${captions.result.value}`);
  }
  for (secondId of nextUrls.map((url) => new URL(url).searchParams.get("v"))) {
    const checkpoint = logs.length;
    if (!playlistMode && !directNavigation) {
      await retry(async () => {
        const value = await client.send("Runtime.evaluate", { expression: searchExpression(), returnByValue: true });
        return value.result.value;
      });
      await retry(async () => {
        const value = await client.send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true });
        return value.result.value === "/results";
      });
    }
    await retry(async () => {
      const value = await client.send("Runtime.evaluate", {
        expression: watchExpression(), returnByValue: true
      });
      return value.result.value;
    });
    try {
      await retry(async () => {
        const value = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
        return value.result.value.includes(secondId);
      });
    } catch (error) {
      const state = await client.send("Runtime.evaluate", {
        expression: `JSON.stringify((() => { const video = document.querySelector("video"); return {
          url: location.href, time: video?.currentTime, duration: video?.duration,
          paused: video?.paused, ended: video?.ended
        }; })())`, returnByValue: true
      });
      throw new Error(`Expected next video ${secondId}. State: ${state.result.value}`);
    }
    await wait(8000);
    result = await client.send("Runtime.evaluate", { expression: playbackExpression(true), returnByValue: true });
    if (!result.result.value.hook) throw new Error("Chromium hook was lost after SPA navigation.");
    const audioState = JSON.parse((await client.send("Runtime.evaluate", {
      expression: "JSON.stringify(globalThis.__uncensoredDebugAudio?.())", returnByValue: true
    })).result.value);
    if (audioState.activeVideoId !== secondId) {
      throw new Error(`Chromium hook retained ${audioState.activeVideoId} after navigating to ${secondId}.`);
    }
    try {
      await retry(async () => {
        if (audioState.audioNeeded === false) return true;
        if (logs.slice(checkpoint).some((line) => line.includes("audio decoded"))) return true;
        await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
        return false;
      }, 90000);
    } catch (error) {
      const state = await client.send("Runtime.evaluate", {
        expression: `JSON.stringify((() => { const video = document.querySelector("video"); return {
          url: location.href, time: video?.currentTime, paused: video?.paused,
          readyState: video?.readyState, captions: document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed")
        }; })())`, returnByValue: true
      });
      throw new Error(`No Chromium audio after SPA navigation. State: ${state.result.value}. Logs: ${logs.slice(checkpoint).slice(-8).join(" | ")}`);
    }
    console.log(`Chromium SPA smoke passed (${secondId}).`);
  }
  client.socket.close();
}

async function firefox() {
  launch("web-ext", ["run", "--source-dir", "dist/firefox", "--firefox", "/usr/bin/firefox",
    "--start-url", firstUrl, "--no-reload", "--no-input", "--arg=-headless",
    `--arg=--remote-debugging-port=${firefoxPort}`]);
  const logs = [];
  let timedTextRequests = 0;
  await retry(() => portReady(firefoxPort));
  const client = socketClient(`ws://127.0.0.1:${firefoxPort}/session`, (message) => {
    if (message.method === "log.entryAdded" && message.params.text.includes("[uncensored]")) {
      logs.push(message.params.text);
      if (verbose) console.log(message.params.text);
    }
    if (message.method === "network.beforeRequestSent" &&
        message.params.request.url.includes("/api/timedtext")) timedTextRequests += 1;
  });
  await client.ready;
  await client.send("session.new", { capabilities: { alwaysMatch: {} } });
  let tree = await client.send("browsingContext.getTree");
  const page = tree.contexts.find((item) => item.url.includes("youtube.com/watch"));
  if (!page) throw new Error("Firefox YouTube page was not created.");
  const context = page.context;
  await client.send("session.subscribe", {
    events: ["log.entryAdded", "network.beforeRequestSent"], contexts: [context]
  });
  async function evaluate(expression) {
    const response = await client.send("script.evaluate", {
      expression, target: { context }, awaitPromise: true, resultOwnership: "none"
    });
    return response.result && response.result.value;
  }
  let state = await retry(async () => {
    const value = JSON.parse(await evaluate(`JSON.stringify(${playbackExpression()})`));
    return value.hook && value;
  });
  await retry(() => timedTextRequests > 0);
  try {
    await retry(async () => logs.some((line) => line.includes("audio decoded")) ||
      await evaluate("globalThis.__uncensoredDebugAudio?.().audioNeeded") === false, 90000);
  } catch (error) {
    const audio = await evaluate("JSON.stringify(globalThis.__uncensoredDebugAudio?.())");
    throw new Error(`No initial Firefox audio or clean-caption decision. State: ${audio}. Logs: ${logs.slice(-12).join(" | ")}`);
  }
  if (pauseFor) {
    await evaluate("document.querySelector('video')?.pause()");
    await wait(pauseFor * 1000);
    const checkpoint = logs.length;
    await evaluate(playbackExpression());
    await retry(async () => {
      if (logs.slice(checkpoint).some((line) => line.includes("audio decoded"))) return true;
      const state = await evaluate("globalThis.__uncensoredDebugAudio?.().audioNeeded");
      if (state === false) return true;
      await evaluate(playbackExpression());
      return false;
    }, 90000);
    console.log(`Firefox pause/resume smoke passed (${pauseFor}s).`);
  }
  if (playUntil) {
    await retry(async () => {
      await evaluate(playbackExpression());
      return await evaluate("document.querySelector('video')?.currentTime") >= playUntil;
    }, (playUntil + 60) * 1000);
    const decoded = decodedThrough(logs);
    const audioNeeded = await evaluate("globalThis.__uncensoredDebugAudio?.().audioNeeded");
    if (audioNeeded !== false && decoded < playUntil - 20) {
      throw new Error(`Firefox audio stopped at ${decoded}s.`);
    }
  }
  for (secondId of nextUrls.map((url) => new URL(url).searchParams.get("v"))) {
    const timedTextCheckpoint = timedTextRequests;
    const logCheckpoint = logs.length;
    if (!playlistMode && !directNavigation) {
      await retry(async () => await evaluate(searchExpression()));
      await retry(async () => await evaluate("location.pathname") === "/results");
    }
    await retry(async () => await evaluate(watchExpression()));
    await retry(async () => (await evaluate("location.href")).includes(secondId));
    await wait(8000);
    state = await retry(async () => {
      const value = JSON.parse(await evaluate(`JSON.stringify(${playbackExpression(true)})`));
      return value.hook && value;
    });
    if (!state.url.includes(secondId)) {
      throw new Error(`Firefox navigation reverted before playback: ${state.url}`);
    }
    await retry(() => timedTextRequests > timedTextCheckpoint);
    const audioState = JSON.parse(await evaluate("JSON.stringify(globalThis.__uncensoredDebugAudio?.())"));
    if (audioState.activeVideoId !== secondId) {
      throw new Error(`Firefox hook retained ${audioState.activeVideoId} after navigating to ${secondId}.`);
    }
    await retry(() => audioState.audioNeeded === false ||
      logs.slice(logCheckpoint).some((line) => line.includes("audio decoded")), 90000);
    console.log(`Firefox SPA smoke passed (${secondId}, ${timedTextRequests} caption requests).`);
  }
  await client.send("session.end");
  client.socket.close();
}

(async () => {
  try {
    if (!firefoxOnly) {
      await chromium();
      children.splice(0).forEach((child) => child.kill("SIGTERM"));
    }
    if (!chromiumOnly) await firefox();
  } finally {
    children.forEach((child) => child.kill("SIGTERM"));
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
