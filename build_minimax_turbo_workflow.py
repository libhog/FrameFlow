import json
from pathlib import Path


SOURCE = Path(r"D:\opt\testProject\video\홍천\video_minimax_h3_i2v.json")
OUTPUT = Path(r"C:\Users\libho\Documents\ChatGPT\미디어아트\video_minimax_h3_i2v_alibaba_pdd_8step.json")
PDD_FILE = "MiniMax-H3-FL2VA-Acc-8Step.safetensors"
SUBGRAPH_ID = "4c314f31-ecda-4b08-ae98-faaba1bf613f"


data = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
instance = next(node for node in data["nodes"] if node["id"] == 105)
if len(instance["widgets_values"]) != 13:
    raise RuntimeError("Unexpected MiniMax subgraph widget layout")
instance["widgets_values"] = instance["widgets_values"][:-4]
instance["inputs"] = [
    item for item in instance["inputs"]
    if item.get("name") not in {"value", "strength_model_1", "value_2"}
]

subgraph = next(sg for sg in data["definitions"]["subgraphs"] if sg["id"] == SUBGRAPH_ID)
removed_input_ids = {
    "5fa5fd85-5efc-45ea-b938-2767dc6a375b",
    "1c18d558-5904-486b-84d8-43b080a2d4dd",
    "a7b69463-a7b0-4eae-991d-c333e4e8d5cd",
    "4a02c41e-7fa6-4faf-9018-7a09de5245d8",
}
subgraph["inputs"] = [item for item in subgraph["inputs"] if item["id"] not in removed_input_ids]

nodes = {node["id"]: node for node in subgraph["nodes"]}
for node_id, expected in {
    6: "UNETLoader", 9: "BasicScheduler", 14: "SamplerCustomAdvanced",
    16: "BasicGuider", 17: "KSamplerSelect", 121: "LoraLoaderModelOnly",
    122: "ComfySwitchNode", 123: "ComfySwitchNode", 124: "PrimitiveInt",
    125: "PrimitiveInt", 126: "PrimitiveBoolean", 128: "PathchSageAttentionKJ",
}.items():
    if nodes[node_id]["type"] != expected:
        raise RuntimeError(f"Node {node_id}: expected {expected}, got {nodes[node_id]['type']}")

nodes[121].clear()
nodes[121].update({
    "id": 121, "type": "MiniMaxH3SigmaShift", "pos": [-1260, 4790],
    "size": [370, 110], "flags": {}, "order": 16, "mode": 0,
    "inputs": [{"name": "model", "type": "MODEL", "link": 229}],
    "outputs": [{"name": "MODEL", "type": "MODEL", "links": [248], "slot_index": 0}],
    "properties": {"Node name for S&R": "MiniMaxH3SigmaShift"},
    "widgets_values": [12.0, 3.0],
    "widgets_values_named": {"shift_video": 12.0, "shift_audio": 3.0},
})
nodes[122].clear()
nodes[122].update({
    "id": 122, "type": "MiniMaxH3PDDAccApply", "pos": [-800, 4790],
    "size": [430, 190], "flags": {}, "order": 17, "mode": 0,
    "inputs": [{"name": "model", "type": "MODEL", "link": 248}],
    "outputs": [
        {"name": "model", "type": "MODEL", "links": [247], "slot_index": 0},
        {"name": "sigmas", "type": "SIGMAS", "links": [18], "slot_index": 1},
        {"name": "info", "type": "STRING", "links": None, "slot_index": 2},
    ],
    "properties": {"Node name for S&R": "MiniMaxH3PDDAccApply"},
    "widgets_values": [PDD_FILE, "8", 1.0, 1.0, "error"],
    "widgets_values_named": {
        "pdd_file": PDD_FILE, "nfe": "8", "lora_strength": 1.0,
        "head_strength": 1.0, "on_off_grid": "error",
    },
})

remove_node_ids = {9, 123, 124, 125, 126}
subgraph["nodes"] = [node for node in subgraph["nodes"] if node["id"] not in remove_node_ids]
remove_link_ids = {232, 233, 234, 235, 236, 237, 238, 239, 240, 243, 244, 245}
subgraph["links"] = [link for link in subgraph["links"] if link["id"] not in remove_link_ids]

links = {link["id"]: link for link in subgraph["links"]}
links[18].update({"origin_id": 122, "origin_slot": 1, "target_id": 14, "target_slot": 3, "type": "SIGMAS"})
links[229].update({"origin_id": 6, "origin_slot": 0, "target_id": 121, "target_slot": 0, "type": "MODEL"})
links[247].update({"origin_id": 122, "origin_slot": 0, "target_id": 128, "target_slot": 0, "type": "MODEL"})
subgraph["links"].append({
    "id": 248, "origin_id": 121, "origin_slot": 0,
    "target_id": 122, "target_slot": 0, "type": "MODEL",
})

nodes[6]["outputs"][0]["links"] = [229]
nodes[14]["inputs"][3]["link"] = 18
nodes[16]["inputs"][0]["link"] = 241
nodes[17]["widgets_values"] = ["euler"]
nodes[17]["widgets_values_named"] = {"sampler_name": "euler"}
nodes[128]["inputs"][0]["link"] = 247
nodes[128]["outputs"][0]["links"] = [241]
nodes[128]["widgets_values"] = ["auto", False]
nodes[128]["widgets_values_named"] = {"sage_attention": "auto", "allow_compile": False}

# Force the Qwen text encoder to leave accelerator memory after conditioning,
# before the guider can trigger loading the H3 diffusion model.
subgraph["nodes"].append({
    "id": 129,
    "type": "DenoTextEncoderUnload",
    "pos": [-350, 5010],
    "size": [380, 112],
    "flags": {},
    "order": 22,
    "mode": 0,
    "inputs": [
        {"name": "value", "type": "*", "link": 187},
        {"name": "clip", "type": "CLIP", "link": 249},
        {"name": "wait_for", "type": "*", "shape": 7, "link": None},
    ],
    "outputs": [{"name": "value", "type": "*", "links": [250]}],
    "properties": {
        "cnr_id": "deno-custom-nodes",
        "ver": "0.7.91",
        "Node name for S&R": "DenoTextEncoderUnload",
    },
    "color": "#4a2e15",
    "bgcolor": "#24170d",
})
links[187].update({
    "origin_id": 104, "origin_slot": 0,
    "target_id": 129, "target_slot": 0, "type": "CONDITIONING",
})
subgraph["links"].extend([
    {"id": 249, "origin_id": 13, "origin_slot": 0,
     "target_id": 129, "target_slot": 1, "type": "CLIP"},
    {"id": 250, "origin_id": 129, "origin_slot": 0,
     "target_id": 16, "target_slot": 1, "type": "CONDITIONING"},
])
nodes[13]["outputs"][0]["links"] = [189, 249]
nodes[16]["inputs"][1]["link"] = 250

subgraph["state"]["lastNodeId"] = max(subgraph["state"].get("lastNodeId", 0), 129)
subgraph["state"]["lastLinkId"] = max(subgraph["state"].get("lastLinkId", 0), 250)
data["last_node_id"] = max(data.get("last_node_id", 0), 129)
data["last_link_id"] = max(data.get("last_link_id", 0), 250)
data.setdefault("extra", {})["minimax_pdd_acc"] = {
    "repository": "alibaba-pai/MiniMax-H3-Acc-LoRAs",
    "custom_node": "Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc",
    "pdd_file": PDD_FILE, "nfe": 8, "sampler": "euler",
    "video_shift": 12.0, "audio_shift": 3.0,
    "lora_strength": 1.0, "head_strength": 1.0, "sage_attention": "auto",
    "text_encoder_unload": "DenoTextEncoderUnload",
}

OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(OUTPUT)
