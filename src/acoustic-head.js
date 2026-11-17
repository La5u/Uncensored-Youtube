(function buildAcousticHead() {
  "use strict";
  // Small conv classifier over tiny.en encoder states around a blank (trained on synthetic-tier
  // slots, tmp/acoustic-train-20261112). Without fusion parameters in the file it only acts where the
  // closed-set decoder abstained or nearly tied ("head-on-uncertain"); with them, `fuse` combines it
  // with the decoder's scores on every slot.
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  // File: uint32 LE header length, JSON header, then float32 / int8 tensors (int8 rows carry a
  // float32 scale). See tmp/acoustic-train-20261112/export_head.py.
  function parse(buffer) {
    var bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    var length = new DataView(bytes).getUint32(0, true);
    var header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, length)));
    var base = 4 + length;
    var models = header.models.map(function load(tensors) {
      var model = {};
      Object.keys(tensors).forEach(function tensor(name) {
        var spec = tensors[name];
        var size = spec[1].reduce(function multiply(a, b) { return a * b; }, 1);
        if (spec[0] === "f32") {
          model[name] = new Float32Array(bytes.slice(base + spec[2], base + spec[2] + 4 * size));
          return;
        }
        var q = new Int8Array(bytes, base + spec[2], size);
        var scale = new Float32Array(bytes.slice(base + spec[3], base + spec[3] + 4 * spec[1][0]));
        var row = size / spec[1][0];
        var w = new Float32Array(size);
        for (var i = 0; i < size; i += 1) w[i] = q[i] * scale[Math.floor(i / row)];
        model[name] = w;
      });
      return model;
    });
    return Object.assign({}, header, { models: models, width: models[0]["proj.bias"].length });
  }

  // erf (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7) for the exact GELU used in training.
  function gelu(x) {
    var z = Math.abs(x) / Math.SQRT2;
    var t = 1 / (1 + 0.3275911 * z);
    var erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * x * (1 + (x < 0 ? -erf : erf));
  }

  function layerNorm(x, offset, n, weight, bias, out, outOffset) {
    var mean = 0, variance = 0, i;
    for (i = 0; i < n; i += 1) mean += x[offset + i];
    mean /= n;
    for (i = 0; i < n; i += 1) variance += (x[offset + i] - mean) * (x[offset + i] - mean);
    var inv = 1 / Math.sqrt(variance / n + 1e-5);
    for (i = 0; i < n; i += 1) out[outOffset + i] = (x[offset + i] - mean) * inv * weight[i] + bias[i];
  }

  // h += gelu(conv1d(h)), kernel 5, "same" padding with the given dilation; h is [frames][width].
  function residualConv(h, frames, width, weight, bias, dilation) {
    var out = new Float32Array(frames * width);
    for (var t = 0; t < frames; t += 1) {
      for (var o = 0; o < width; o += 1) {
        var sum = bias[o];
        for (var k = 0; k < 5; k += 1) {
          var s = t + (k - 2) * dilation;
          if (s < 0 || s >= frames) continue;
          for (var i = 0, w = o * width * 5 + k, x = s * width; i < width; i += 1, w += 5) sum += weight[w] * h[x + i];
        }
        out[t * width + o] = gelu(sum);
      }
    }
    for (var j = 0; j < out.length; j += 1) h[j] += out[j];
  }

  // One fold model: LayerNorm, 2x average pool, 1x1 projection, two residual convs (dilation 1, 2),
  // masked attention pooling, LayerNorm, linear. Returns class probabilities.
  function forwardModel(m, head, x, mask) {
    var D = head.dim, W = head.width, F = head.frames, T = F / 2;
    var normed = new Float32Array(F * D);
    var pooled = new Float32Array(T * D);
    var h = new Float32Array(T * W);
    var valid = [];
    var t, d, o;
    for (t = 0; t < F; t += 1) layerNorm(x, t * D, D, m["norm.weight"], m["norm.bias"], normed, t * D);
    for (t = 0; t < T; t += 1) {
      valid.push(mask[2 * t] || mask[2 * t + 1]);
      for (d = 0; d < D; d += 1) pooled[t * D + d] = (normed[2 * t * D + d] + normed[(2 * t + 1) * D + d]) / 2;
    }
    for (t = 0; t < T; t += 1) {
      for (o = 0; o < W; o += 1) {
        var sum = m["proj.bias"][o];
        for (d = 0; d < D; d += 1) sum += m["proj.weight"][o * D + d] * pooled[t * D + d];
        h[t * W + o] = gelu(sum);
      }
    }
    residualConv(h, T, W, m["c1.weight"], m["c1.bias"], 1);
    residualConv(h, T, W, m["cs.0.weight"], m["cs.0.bias"], 2);
    var scores = [], max = -Infinity, total = 0;
    for (t = 0; t < T; t += 1) {
      var score = m["pool.score.bias"][0] + m["pool.pos"][t];
      for (o = 0; o < W; o += 1) score += m["pool.score.weight"][o] * h[t * W + o];
      scores.push(valid[t] ? score : -1e4);
      max = Math.max(max, scores[t]);
    }
    var vector = new Float32Array(W);
    for (t = 0; t < T; t += 1) { scores[t] = Math.exp(scores[t] - max); total += scores[t]; }
    for (t = 0; t < T; t += 1) for (o = 0; o < W; o += 1) vector[o] += scores[t] / total * h[t * W + o];
    layerNorm(vector, 0, W, m["n2.weight"], m["n2.bias"], vector, 0);
    var C = head.words.length, logits = new Float32Array(C), top = -Infinity, norm = 0, c;
    for (c = 0; c < C; c += 1) {
      var z = m["out.bias"][c];
      for (o = 0; o < W; o += 1) z += m["out.weight"][c * W + o] * vector[o];
      logits[c] = z;
      top = Math.max(top, z);
    }
    for (c = 0; c < C; c += 1) { logits[c] = Math.exp(logits[c] - top); norm += logits[c]; }
    for (c = 0; c < C; c += 1) logits[c] /= norm;
    return logits;
  }

  // Mean probability of the fold models. x: [frames][dim] crop, mask: frames inside the window.
  function forward(head, x, mask) {
    var probs = new Float32Array(head.words.length);
    head.models.forEach(function add(m) {
      var p = forwardModel(m, head, x, mask);
      for (var c = 0; c < probs.length; c += 1) probs[c] += p[c] / head.models.length;
    });
    return probs;
  }

  // Crop encoder states [frameCount][dim] around a blank `seconds` after the window start.
  function crop(head, hidden, frameCount, seconds) {
    var center = Math.round(seconds * head.framesPerSecond);
    var x = new Float32Array(head.frames * head.dim);
    var mask = [];
    for (var t = 0; t < head.frames; t += 1) {
      var frame = center - head.before + t;
      mask.push(frame >= 0 && frame < frameCount);
      if (mask[t]) x.set(hidden.subarray(frame * head.dim, (frame + 1) * head.dim), t * head.dim);
    }
    return { x: x, mask: mask };
  }

  // The decoder abstained, or its two best gated words (log P >= minLogProb) are within `margin`
  // on log P(word + next word).
  function uncertain(decision, minLogProb, margin) {
    if (!decision || !decision.word) return true;
    var gated = (decision.scores || []).filter(function gate(s) { return s.logp >= minLogProb; })
      .map(function next(s) { return s.withNext; }).sort(function desc(a, b) { return b - a; });
    return gated.length > 1 && gated[0] - gated[1] <= margin;
  }

  // The head's most probable word and its probability.
  function top(head, probs) {
    var best = 0;
    for (var c = 1; c < probs.length; c += 1) if (probs[c] > probs[best]) best = c;
    return { word: head.words[best], p: probs[best] };
  }

  // Head word for an uncertain slot when its probability clears the threshold, else "".
  function choose(head, probs, candidates) {
    var best = top(head, probs);
    return best.p >= head.threshold && (!candidates || candidates.indexOf(best.word) >= 0) ? best.word : "";
  }

  // Fusion (only when the file carries `fusion`): softmax over the head's words of
  // weights . [log head p, decoder log P(word), decoder log P(word + next)]; words the decoder did not
  // score get `prunedMax` minus unscored[0] (or unscored[1] when nothing was pruned). The fused word is
  // used if it clears the threshold and is a candidate, else the decoder's word. Where the decoder is
  // confident, a fused word of the same family keeps the decoder's form (inflections).
  function fuse(head, probs, decision, candidates, minLogProb) {
    var f = head.fusion, scores = Object.create(null), z = [], best = 0, total = 0;
    var decoderWord = decision && decision.word || "";
    var fill = isFinite(decision && decision.prunedMax) ? decision.prunedMax - f.unscored[0] : f.unscored[1];
    ((decision && decision.scores) || []).forEach(function index(s) { scores[s.word] = s; });
    head.words.forEach(function logit(word, c) {
      var s = scores[word];
      z.push(f.weights[0] * Math.log(Math.max(probs[c], 1e-12)) + f.weights[1] * (s ? s.logp : fill) + f.weights[2] * (s ? s.withNext : fill));
      if (z[c] > z[best]) best = c;
    });
    z.forEach(function add(v) { total += Math.exp(v - z[best]); });
    var word = head.words[best], p = 1 / total;
    if (p < f.threshold || (candidates && candidates.indexOf(word) < 0)) word = decoderWord;
    var known = head.words.indexOf(decoderWord);
    if (decoderWord && (known < 0 || (!uncertain(decision, minLogProb, head.margin) && f.family[best] === f.family[known]))) {
      word = decoderWord;
    }
    return { word: word, p: p };
  }

  // Fetch and parse the weights. Resolves { model, error }: on any failure model is null (run without
  // the head), error holds the reason and one warning is logged.
  function load(url) {
    return root.fetch(url).then(function read(response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.arrayBuffer();
    }).then(function loaded(buffer) {
      return { model: parse(buffer), error: "" };
    }).catch(function withoutHead(error) {
      var reason = error && (error.message || String(error)) || "unknown error";
      root.console.warn("[uncensored] acoustic head unavailable:", reason);
      return { model: null, error: reason };
    });
  }

  var exports = Object.freeze({ parse: parse, load: load, forward: forward, crop: crop, uncertain: uncertain,
    top: top, choose: choose, fuse: fuse });
  root.UncensoredAcousticHead = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
