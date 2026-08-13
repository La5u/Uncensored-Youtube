const fs = require("fs");
const crypto = require("crypto");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const cleanupOnly = args.includes("--cleanup");
const verbose = args.includes("--verbose");
const headless = args.includes("--headless");
const firefoxOnly = args.includes("--firefox-only");
const chromiumOnly = args.includes("--chromium-only");
const navigationRoute = (args.find((arg) => arg.startsWith("--via=")) || "").split("=")[1] ||
  (args.includes("--direct") ? "direct" : "search");
const directNavigation = navigationRoute === "direct";
const homeNavigation = navigationRoute === "home";
const initialOnly = args.includes("--initial-only");
const playUntil = Number((args.find((arg) => arg.startsWith("--until=")) || "").split("=")[1]) || 0;
const pauseFor = Number((args.find((arg) => arg.startsWith("--pause=")) || "").split("=")[1]) || 0;
const autoNextCount = Number((args.find((arg) => arg.startsWith("--auto-next=")) || "").split("=")[1]) || 0;
const mode = (args.find((arg) => arg.startsWith("--mode=")) || "").split("=")[1] || "";
const expectedWords = (args.find((arg) => arg.startsWith("--expect=")) || "").split("=")[1]
  ?.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean) || [];
const validModes = new Set(["rules-only", "whisper-only", "hybrid", "both-off"]);
if (mode && !validModes.has(mode)) throw new Error(`Unknown smoke mode: ${mode}`);
if (!["search", "direct", "home"].includes(navigationRoute)) {
  throw new Error(`Unknown navigation route: ${navigationRoute}`);
}
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

const cleanDecision = (logs, start = 0) =>
  logs.slice(start).some((line) => line.includes("audio decoding stopped") ||
    line.includes("captions analyzed") && line.includes('"count":0'));
const audioMode = mode !== "rules-only" && mode !== "both-off";
const inferenceReady = (logs, start = 0) => audioMode
  ? logs.slice(start).some((line) => line.includes("audio decoded")) || cleanDecision(logs, start)
  : logs.slice(start).some((line) => line.includes("captions analyzed"));

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
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  children.push(child);
  child.on("exit", () => {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
  });
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => {
    const text = String(data);
    if (text.includes("[uncensored]") || text.includes("Extension ID")) process.stderr.write(text);
  });
  return child;
}

function chromiumExtensionId(extensionPath) {
  return [...crypto.createHash("sha256").update(extensionPath).digest("hex").slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

function pkill(pattern, signal) {
  try {
    execSync(`pkill -${signal} -f '${pattern}'`);
  } catch (ignored) {}
}

const HEADLESS_FIREFOX = "^/usr/lib/firefox/firefox .* -headless( |$)";
const CHROMIUM_SMOKE = "[u]ncensored-chromium-smoke-";

function removeGeneratedProfiles() {
  fs.readdirSync("/tmp").filter((name) =>
    name.startsWith("uncensored-chromium-smoke-") || name.startsWith("firefox-profile")
  ).forEach((name) => fs.rmSync(path.join("/tmp", name), { recursive: true, force: true }));
}

function terminateChildren() {
  children.slice().forEach((child) => {
    try {
      child.kill("SIGTERM");
    } catch (ignored) {}
  });
  pkill(HEADLESS_FIREFOX, "TERM");
  pkill(CHROMIUM_SMOKE, "TERM");
}

function hardTerminate() {
  children.forEach((child) => {
    try {
      child.kill("SIGKILL");
    } catch (ignored) {}
  });
  pkill(HEADLESS_FIREFOX, "KILL");
  pkill(CHROMIUM_SMOKE, "KILL");
  process.exit(0);
}

process.on("SIGTERM", () => {
  terminateChildren();
  setTimeout(hardTerminate, 3000).unref();
});
process.on("SIGINT", () => {
  terminateChildren();
  setTimeout(hardTerminate, 3000).unref();
});

function cleanupOrphanedSmokeBrowsers() {
  pkill(HEADLESS_FIREFOX, "KILL");
  pkill(CHROMIUM_SMOKE, "KILL");
  pkill("[w]eb-ext.*dist/(chromium|firefox)", "KILL");
  removeGeneratedProfiles();
  console.log("Cleaned leftover headless smoke browsers and profiles.");
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
    const responseAutomatic = player?.getPlayerResponse?.()?.captions
      ?.playerCaptionsTracklistRenderer?.captionTracks?.find(track =>
        track.languageCode === "en" && track.kind === "asr");
    const automatic = responseAutomatic || player?.getOption?.("captions", "tracklist")?.find(track =>
      track.languageCode === "en" && (track.kind === "asr" || !track.kind));
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
    // Firefox must start playback at the early Fetch-hook point or initial SABR can be buffered first.
    return { hook: globalThis.fetch?.name === "uncensoredFetch", url: location.href };
  })()`;
}

function fetchTransparencyExpression() {
  return `(async () => {
    const urlDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "url");
    const clone = Response.prototype.clone;
    try {
      Object.defineProperty(Response.prototype, "url", { configurable: true, get: () => "" });
      let response = await fetch("data:text/plain,synthetic-response");
      if (await response.text() !== "synthetic-response") throw new Error("empty response.url altered Fetch");

      Object.defineProperty(Response.prototype, "url", { configurable: true,
        get: () => "https://rr1.googlevideo.com/videoplayback?sabr=1" });
      Response.prototype.clone = () => { throw new Error("synthetic response cannot be cloned"); };
      response = await fetch("data:text/plain,uncloneable-response");
      if (await response.text() !== "uncloneable-response") throw new Error("clone failure altered Fetch");
      return true;
    } finally {
      Object.defineProperty(Response.prototype, "url", urlDescriptor);
      Response.prototype.clone = clone;
    }
  })()`;
}

function finishCurrentVideoExpression() {
  return `(() => {
    const video = document.querySelector("video");
    const id = new URL(location.href).searchParams.get("v");
    if (!video || !Number.isFinite(video.duration) || video.duration <= 2) return "";
    video.muted = true;
    video.playbackRate = 2;
    video.currentTime = video.duration - 1;
    video.play().catch(() => {});
    return id;
  })()`;
}

function visibleCaptionExpression() {
  return `(() => {
    const selector = ".ytp-caption-segment, .caption-window span, .caption-visual-line span";
    const nodes = [...document.querySelectorAll(selector)].filter(node => !node.querySelector(selector));
    const captions = nodes.map(node => node.textContent || "").filter(Boolean);
    const text = captions.join(" ").toLowerCase().replace(/[^a-z0-9_'\[\] ]+/g, " ").replace(/\\s+/g, " ").trim();
    return { captions, text, time: document.querySelector("video")?.currentTime,
      subtitleButton: document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed"),
      selectedTrack: document.querySelector("#movie_player")?.getOption?.("captions", "track") || {},
      tracks: document.querySelector("#movie_player")?.getOption?.("captions", "tracklist")?.map(track =>
        ({ languageCode: track.languageCode, kind: track.kind, vssId: track.vssId, name: track.name })) || [],
      responseTracks: document.querySelector("#movie_player")?.getPlayerResponse?.()?.captions
        ?.playerCaptionsTracklistRenderer?.captionTracks?.map(track =>
        ({ languageCode: track.languageCode, kind: track.kind, name: track.name })) || [],
      placeholders: (text.match(/\\[\\s*__\\s*\\]/g) || []).length };
  })()`;
}

function homeExpression() {
  return `(() => {
    if (location.pathname === "/") return true;
    const home = document.querySelector("ytd-topbar-logo-renderer a, a#logo, #logo a");
    if (!home) return false;
    home.click();
    return true;
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
    if (${directNavigation}) {
      location.assign("https://www.youtube.com/watch?v=" + encodeURIComponent(id));
      return true;
    }
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
      const link = [...document.querySelectorAll('a[href*="/watch?v="]')]
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
  if (mode) {
    const extensionId = chromiumExtensionId(extensionPaths[0]);
    const extensionUrl = `chrome-extension://${extensionId}/src/popup.html`;
    const values = {
      rulesEnabled: mode !== "whisper-only" && mode !== "both-off",
      whisperEnabled: mode !== "rules-only" && mode !== "both-off"
    };
    await client.send("Page.navigate", { url: extensionUrl });
    await retry(async () => {
      const response = await client.send("Runtime.evaluate", {
        expression: `chrome.storage.local.set(${JSON.stringify(values)}).then(() => true)`,
        awaitPromise: true, returnByValue: true
      });
      return response.result.value === true;
    });
    console.log(`Chromium mode ${mode}: ${JSON.stringify(values)}.`);
  }
  await client.send("Page.navigate", { url: launchUrl.href });
  if (!firstSeekTime) await wait(10000);
  let result = await retry(async () => {
    const response = await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
    return response.result.value.hook && response;
  });
  result = await client.send("Runtime.evaluate", {
    expression: fetchTransparencyExpression(), awaitPromise: true, returnByValue: true
  });
  if (result.result.value !== true) throw new Error("Chromium Fetch transparency check failed.");
  console.log("Chromium Fetch transparency check passed.");
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
      if (inferenceReady(logs)) return true;
      await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
      return false;
    }, 90000);
  } catch (error) {
    const state = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({time: document.querySelector("video")?.currentTime,
        paused: document.querySelector("video")?.paused,
        captions: document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed")})`, returnByValue: true
    });
    throw new Error(`No initial Chromium audio or clean-caption decision. State: ${state.result.value}`);
  }
  if (expectedWords.length || mode === "both-off") {
    try {
      const visible = await retry(async () => {
        await client.send("Runtime.evaluate", { expression: `(() => {
          const player = document.querySelector("#movie_player");
          const automatic = player?.getPlayerResponse?.()?.captions
            ?.playerCaptionsTracklistRenderer?.captionTracks?.find(track =>
              track.languageCode === "en" && track.kind === "asr");
          if (automatic) player.setOption("captions", "track", {
            languageCode: automatic.languageCode, kind: automatic.kind, vssId: automatic.vssId || ""
          });
          const captions = document.querySelector(".ytp-subtitles-button");
          if (captions && captions.getAttribute("aria-pressed") !== "true") captions.click();
          return true;
        })()`, returnByValue: true });
        if (firstSeekTime) {
          await client.send("Runtime.evaluate", { expression: `(() => {
            const video = document.querySelector("video");
            const player = document.querySelector("#movie_player");
            if (video && Math.abs(video.currentTime - ${firstSeekTime}) > 2 && player?.seekTo) {
              player.seekTo(${firstSeekTime}, true);
            }
            if (video) { video.playbackRate = 0.25; video.play().catch(() => {}); }
            return true;
          })()`, returnByValue: true });
        }
        const response = await client.send("Runtime.evaluate", {
          expression: visibleCaptionExpression(), returnByValue: true
        });
        const state = response.result.value;
        if (verbose && state.text) console.log(`Visible captions: ${JSON.stringify(state)}`);
        const found = expectedWords.every((word) =>
          new RegExp("(?:^| )" + word.replace(/[^a-z0-9' ]/g, "") + "(?: |$)").test(state.text));
        const disabled = mode === "both-off" && state.placeholders > 0;
        return (found && (!mode || state.selectedTrack.kind === "asr") || disabled) && state;
      }, 20000);
      if (mode === "both-off") {
        if (!visible.placeholders) {
          throw new Error(`Disabled mode did not preserve a [__] slot: ${JSON.stringify(visible)}.`);
        }
        console.log(`Chromium DOM disabled-mode check passed (${firstUrl}, ${JSON.stringify(visible)}).`);
      } else {
        if (visible.placeholders) {
          throw new Error(`Resolved caption still contains ${visible.placeholders} [__] slot(s): ${JSON.stringify(visible)}.`);
        }
        console.log(`Chromium DOM expectation passed (${mode || "default"}, ${firstUrl}, ${JSON.stringify(visible)}).`);
      }
    } catch (error) {
      const response = await client.send("Runtime.evaluate", {
        expression: visibleCaptionExpression(), returnByValue: true
      });
      throw new Error(`${error.message}; final DOM: ${JSON.stringify(response.result.value)}`);
    }
  }
  if (pauseFor) {
    await client.send("Runtime.evaluate", { expression: "document.querySelector('video')?.pause()" });
    await wait(pauseFor * 1000);
    const checkpoint = logs.length;
    await client.send("Runtime.evaluate", { expression: playbackExpression(), returnByValue: true });
    await retry(async () => {
      if (inferenceReady(logs, checkpoint)) return true;
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
    if (audioMode && !cleanDecision(logs) && decoded < playUntil - 20) {
      throw new Error(`Audio stopped at ${decoded}s.`);
    }
  }
  if (verbose && firstSeekTime) {
    await wait(5000);
    const captions = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({time: document.querySelector("video")?.currentTime,
        captions: [...document.querySelectorAll(".ytp-caption-segment")].map(node => node.textContent),
        tracks: document.querySelector("#movie_player")?.getOption?.("captions", "tracklist")?.length,
        responseCaptions: !!document.querySelector("#movie_player")?.getPlayerResponse?.()?.captions})`,
      returnByValue: true
    });
    console.log(`Visible captions at ${firstSeekTime}: ${captions.result.value}`);
  }
  if (initialOnly) {
    client.socket.close();
    return;
  }
  if (autoNextCount) {
    for (let index = 0; index < autoNextCount; index += 1) {
      const checkpoint = logs.length;
      const current = await retry(async () => {
        const value = await client.send("Runtime.evaluate", {
          expression: finishCurrentVideoExpression(), returnByValue: true
        });
        return value.result.value;
      });
      const next = await retry(async () => {
        const value = await client.send("Runtime.evaluate", {
          expression: "new URL(location.href).searchParams.get('v')", returnByValue: true
        });
        return value.result.value && value.result.value !== current && value.result.value;
      }, 90000);
      await wait(5000);
      const state = await client.send("Runtime.evaluate", { expression: playbackExpression(true), returnByValue: true });
      if (!state.result.value.hook) throw new Error(`Chromium hook lost after playlist advance to ${next}.`);
      await retry(() => inferenceReady(logs, checkpoint), 90000);
      console.log(`Chromium playlist auto-next passed (${current} -> ${next}).`);
    }
    client.socket.close();
    return;
  }
  for (secondId of nextUrls.map((url) => new URL(url).searchParams.get("v"))) {
    const checkpoint = logs.length;
    if (homeNavigation) {
      await retry(async () => {
        const value = await client.send("Runtime.evaluate", { expression: homeExpression(), returnByValue: true });
        return value.result.value;
      });
      await retry(async () => {
        const value = await client.send("Runtime.evaluate", {
          expression: `location.pathname === "/" && navigator.onLine &&
            !document.body.innerText.includes("Connect to the internet")`, returnByValue: true
        });
        return value.result.value;
      });
      await client.send("Runtime.evaluate", {
        expression: `location.assign(${JSON.stringify("https://www.youtube.com/watch?v=")} + ${JSON.stringify(secondId)})`
      });
    } else if (!playlistMode && !directNavigation) {
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
    if (!homeNavigation && !logs.slice(checkpoint).some((line) => line.includes(`new video ${secondId}`))) {
      throw new Error(`Chromium hook did not activate video ${secondId}.`);
    }
    try {
      await retry(async () => {
        if (inferenceReady(logs, checkpoint)) return true;
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
  const page = await retry(async () => {
    const tree = await client.send("browsingContext.getTree");
    return tree.contexts.find((item) => item.url.includes("youtube.com/watch"));
  });
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
  if (!await evaluate(fetchTransparencyExpression())) throw new Error("Firefox Fetch transparency check failed.");
  console.log("Firefox Fetch transparency check passed.");
  await retry(() => timedTextRequests > 0 || cleanDecision(logs));
  try {
    await retry(() => inferenceReady(logs), 90000);
  } catch (error) {
    throw new Error(`No initial Firefox audio or clean-caption decision. Logs: ${logs.slice(-12).join(" | ")}`);
  }
  if (pauseFor) {
    await evaluate("document.querySelector('video')?.pause()");
    await wait(pauseFor * 1000);
    const checkpoint = logs.length;
    await evaluate(playbackExpression());
    await retry(async () => {
      if (inferenceReady(logs, checkpoint)) return true;
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
    if (audioMode && !cleanDecision(logs) && decoded < playUntil - 20) {
      throw new Error(`Firefox audio stopped at ${decoded}s.`);
    }
  }
  if (initialOnly) {
    await client.send("session.end");
    client.socket.close();
    return;
  }
  if (autoNextCount) {
    for (let index = 0; index < autoNextCount; index += 1) {
      const timedTextCheckpoint = timedTextRequests;
      const logCheckpoint = logs.length;
      const current = await retry(async () => await evaluate(finishCurrentVideoExpression()));
      const next = await retry(async () => {
        const id = await evaluate("new URL(location.href).searchParams.get('v')");
        return id && id !== current && id;
      }, 90000);
      await wait(5000);
      const state = JSON.parse(await evaluate(`JSON.stringify(${playbackExpression(true)})`));
      if (!state.hook) throw new Error(`Firefox hook lost after playlist advance to ${next}.`);
      await retry(() => timedTextRequests > timedTextCheckpoint || cleanDecision(logs, logCheckpoint));
      await retry(() => inferenceReady(logs, logCheckpoint), 90000);
      console.log(`Firefox playlist auto-next passed (${current} -> ${next}).`);
    }
    await client.send("session.end");
    client.socket.close();
    return;
  }
  for (secondId of nextUrls.map((url) => new URL(url).searchParams.get("v"))) {
    const timedTextCheckpoint = timedTextRequests;
    const logCheckpoint = logs.length;
    if (homeNavigation) {
      await retry(async () => await evaluate(homeExpression()));
      await retry(async () => await evaluate(`location.pathname === "/" && navigator.onLine &&
        !document.body.innerText.includes("Connect to the internet")`));
      await evaluate(`location.assign(${JSON.stringify("https://www.youtube.com/watch?v=")} + ${JSON.stringify(secondId)}); true`);
    } else if (!playlistMode && !directNavigation) {
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
    await retry(() => timedTextRequests > timedTextCheckpoint || cleanDecision(logs, logCheckpoint));
    if (!homeNavigation && !logs.slice(logCheckpoint).some((line) => line.includes(`new video ${secondId}`))) {
      throw new Error(`Firefox hook did not activate video ${secondId}.`);
    }
    await retry(() => inferenceReady(logs, logCheckpoint), 90000);
    console.log(`Firefox SPA smoke passed (${secondId}, ${timedTextRequests} caption requests).`);
  }
  await client.send("session.end");
  client.socket.close();
}

(async () => {
  if (cleanupOnly) {
    cleanupOrphanedSmokeBrowsers();
    return;
  }
  try {
    if (!firefoxOnly) {
      await chromium();
      terminateChildren();
    }
    if (!chromiumOnly) await firefox();
  } finally {
    terminateChildren();
    removeGeneratedProfiles();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
