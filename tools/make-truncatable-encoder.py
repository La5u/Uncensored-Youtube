# Make a Whisper encoder accept fewer than 3000 mel frames (whisper-local.js encodes the real audio plus
# 2 s of silence): slice the [1500, 384] positional table to the actual frame count instead of adding it whole.
# The shipped encoder: this script on the fp32 encoder_model.onnx, then q8 quantization (onnxruntime.quantization).
# python tools/make-truncatable-encoder.py in.onnx out.onnx   (needs onnx, onnxruntime, numpy)
import sys, onnx, numpy as np
from onnx import helper, numpy_helper
m = onnx.load(sys.argv[1]); g = m.graph
add = next(n for n in g.node if n.name == "/Add_2")
x, pos = add.input
g.initializer.extend([numpy_helper.from_array(np.array([1], np.int64), "trunc_one"),
                      numpy_helper.from_array(np.array([2], np.int64), "trunc_two"),
                      numpy_helper.from_array(np.array([0], np.int64), "trunc_zero")])
nodes = [helper.make_node("Shape", [x], ["trunc_shape"], name="trunc_Shape"),
         helper.make_node("Slice", ["trunc_shape", "trunc_one", "trunc_two", "trunc_zero"], ["trunc_len"], name="trunc_Len"),
         helper.make_node("Slice", [pos, "trunc_zero", "trunc_len", "trunc_zero"], ["trunc_pos"], name="trunc_Pos")]
add.input[1] = "trunc_pos"
idx = list(g.node).index(add)
for k, n in enumerate(nodes): g.node.insert(idx + k, n)
inits = {i.name: i for i in g.initializer}
for n in g.node:  # constant-folded reshape targets [-1, 1500, heads, dim] -> copy the frame axis (0)
    if n.op_type == "Reshape" and n.input[1] in inits:
        t = numpy_helper.to_array(inits[n.input[1]]).copy()
        if t.ndim == 1 and len(t) >= 2 and t[1] == 1500:
            t[1] = 0; inits[n.input[1]].CopyFrom(numpy_helper.from_array(t, n.input[1]))
del g.value_info[:]
for o in g.output:  # dynamic frame axis on outputs
    for d in o.type.tensor_type.shape.dim:
        if d.dim_value == 1500: d.dim_param = "frames"
onnx.save(m, sys.argv[2])
import onnxruntime as ort
s = ort.InferenceSession(sys.argv[2], providers=["CPUExecutionProvider"])
for n in (3000, 600):
    out = s.run(["last_hidden_state"], {"input_features": np.zeros((1, 80, n), np.float32)})[0]
    print(sys.argv[2], n, out.shape)
