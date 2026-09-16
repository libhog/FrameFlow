import json
from pathlib import Path


SOURCE = Path(r"D:\opt\testProject\video\홍천\video_minimax_h3_i2v.json")
OUTPUT = Path(r"C:\Users\libho\Documents\ChatGPT\미디어아트\video_minimax_h3_i2v.qwen-unload.json")
SUBGRAPH_ID = "4c314f31-ecda-4b08-ae98-faaba1bf613f"


data = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
subgraph = next(sg for sg in data["definitions"]["subgraphs"] if sg["id"] == SUBGRAPH_ID)
nodes = {node["id"]: node for node in subgraph["nodes"]}

for node_id, expected_type in {
    13: "CLIPLoader",
    16: "BasicGuider",
    104: "MiniMaxH3ImageToVideo",
}.items():
    if nodes[node_id]["type"] != expected_type:
        raise RuntimeError(f"Node {node_id}: expected {expected_type}, got {nodes[node_id]['type']}")
if any(node["type"] == "DenoTextEncoderUnload" for node in subgraph["nodes"]):
    raise RuntimeError("DenoTextEncoderUnload already exists")

links = {link["id"]: link for link in subgraph["links"]}
if links[187]["origin_id"] != 104 or links[187]["target_id"] != 16:
    raise RuntimeError("Unexpected conditioning link 187")

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
        {"name": "clip", "type": "CLIP", "link": 248},
        {"name": "wait_for", "type": "*", "shape": 7, "link": None},
    ],
    "outputs": [{"name": "value", "type": "*", "links": [249]}],
    "properties": {
        "cnr_id": "deno-custom-nodes",
        "ver": "0.7.91",
        "Node name for S&R": "DenoTextEncoderUnload",
    },
    "color": "#4a2e15",
    "bgcolor": "#24170d",
})

links[187].update({
    "origin_id": 104,
    "origin_slot": 0,
    "target_id": 129,
    "target_slot": 0,
    "type": "CONDITIONING",
})
subgraph["links"].extend([
    {"id": 248, "origin_id": 13, "origin_slot": 0,
     "target_id": 129, "target_slot": 1, "type": "CLIP"},
    {"id": 249, "origin_id": 129, "origin_slot": 0,
     "target_id": 16, "target_slot": 1, "type": "CONDITIONING"},
])

nodes[13]["outputs"][0]["links"] = [189, 248]
nodes[16]["inputs"][1]["link"] = 249
subgraph["state"]["lastNodeId"] = max(subgraph["state"].get("lastNodeId", 0), 129)
subgraph["state"]["lastLinkId"] = max(subgraph["state"].get("lastLinkId", 0), 249)
data["last_node_id"] = max(data.get("last_node_id", 0), 129)
data["last_link_id"] = max(data.get("last_link_id", 0), 249)
data.setdefault("extra", {})["qwen_text_encoder_unload"] = {
    "node": "DenoTextEncoderUnload",
    "after": "MiniMaxH3ImageToVideo",
    "before": "BasicGuider",
}

OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(OUTPUT)
