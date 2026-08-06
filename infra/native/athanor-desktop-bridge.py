#!/usr/bin/python3
"""Private AT-SPI bridge for the native athanor agent account.

Runs either as a one-shot filter (one JSON request on stdin, one response on stdout) or, with
--serve, as a long-lived newline-delimited JSON loop. The loop exists because importing
pyatspi pulls in the whole GObject introspection stack: paying that once per session instead
of once per agent action is the difference between a desktop that responds and one that
stutters.
"""

import json
import re
import sys


SENSITIVE = re.compile(
    r"\b(password|passcode|one.?time|otp|verification code|credit.?card|cvv|cvc|"
    r"social security|ssn|passport|bank account|secret|token)\b",
    re.IGNORECASE,
)

_ATSPI = None


def atspi():
    """Imports pyatspi on first use, so --serve can answer a readiness probe before it."""
    global _ATSPI
    if _ATSPI is None:
        import pyatspi as module

        _ATSPI = module
    return _ATSPI


def children(node):
    try:
        return [node[index] for index in range(node.childCount)]
    except Exception:
        return []


def state_names(node):
    try:
        return sorted(str(value).split("_")[-1].lower() for value in node.getState().getStates())
    except Exception:
        return []


def node_at(node_id):
    node = atspi().Registry.getDesktop(0)
    if node_id in ("", "root"):
        return node
    for raw_index in node_id.split("/"):
        node = node[int(raw_index)]
    return node


def describe(node, node_id, parent_id):
    name = str(getattr(node, "name", "") or "")[:500]
    description = str(getattr(node, "description", "") or "")[:1000]
    try:
        role = str(node.getRoleName() or "unknown")
    except Exception:
        role = "unknown"
    states = state_names(node)
    interfaces = []
    actions = []
    bounds = None
    text = None
    try:
        component = node.queryComponent()
        interfaces.append("component")
        rect = component.getExtents(atspi().DESKTOP_COORDS)
        bounds = {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
    except Exception:
        pass
    try:
        action = node.queryAction()
        interfaces.append("action")
        actions = [str(action.getName(index) or "") for index in range(action.nActions)]
    except Exception:
        pass
    try:
        node.queryEditableText()
        interfaces.append("editable_text")
    except Exception:
        pass
    try:
        text_iface = node.queryText()
        interfaces.append("text")
        if "password text" not in role.lower():
            text = str(text_iface.getText(0, min(text_iface.characterCount, 2000)) or "")
    except Exception:
        pass
    sensitive = "password" in role.lower() or bool(SENSITIVE.search(f"{name} {description} {role}"))
    result = {
        "id": node_id,
        "parentId": parent_id,
        "name": name,
        "description": description,
        "role": role,
        "states": states,
        "actions": actions,
        "interfaces": interfaces,
        "bounds": bounds,
        "sensitive": sensitive,
    }
    if text is not None:
        result["text"] = text
    return result


def observe(max_nodes):
    desktop = atspi().Registry.getDesktop(0)
    nodes = []
    queue = [(child, str(index), None) for index, child in enumerate(children(desktop))]
    while queue and len(nodes) < max_nodes:
        current, node_id, parent_id = queue.pop(0)
        nodes.append(describe(current, node_id, parent_id))
        queue.extend(
            (child, f"{node_id}/{index}", node_id)
            for index, child in enumerate(children(current))
        )
    windows = [
        {"id": node["id"], "name": node["name"], "role": node["role"]}
        for node in nodes
        if node["parentId"] is None or node["role"].lower() in ("frame", "window", "dialog")
    ][:100]
    focused = next(
        (node for node in nodes if "focused" in node["states"] and node["name"]),
        next((node for node in nodes if node["name"]), None),
    )
    return {
        "activeApplication": focused["name"] if focused else "",
        "windows": windows,
        "nodes": nodes,
    }


def perform(action):
    node = node_at(action["nodeId"])
    kind = action["type"]
    if kind == "invoke":
        accessible_action = node.queryAction()
        index = int(action.get("actionIndex", 0))
        if index < 0 or index >= accessible_action.nActions:
            raise ValueError("Accessibility action index is out of range")
        if not accessible_action.doAction(index):
            raise RuntimeError("Application declined the accessibility action")
    elif kind == "focus":
        if not node.queryComponent().grabFocus():
            raise RuntimeError("Application declined the focus request")
    elif kind == "set_text":
        node.queryEditableText().setTextContents(action.get("text", ""))
    else:
        raise ValueError(f"Unsupported semantic action: {kind}")
    return {"ok": True, "action": kind, "nodeId": action["nodeId"]}


def dispatch(request):
    operation = request.get("operation")
    if operation == "observe":
        return observe(max(1, min(int(request.get("maxNodes", 900)), 2000)))
    if operation == "node":
        node_id = str(request["nodeId"])
        parent_id = node_id.rsplit("/", 1)[0] if "/" in node_id else None
        return {"result": describe(node_at(node_id), node_id, parent_id)}
    if operation == "act":
        return {"result": perform(request["action"])}
    if operation == "ping":
        # Warms the accessibility stack and tells the runner whether this session will be
        # able to answer semantic queries at all, before an agent action depends on it.
        try:
            atspi()
            available = True
        except Exception:
            available = False
        return {"result": {"ok": True, "atspi": available}}
    raise ValueError("Unsupported desktop bridge operation")


def serve():
    """One JSON request per line in, one JSON response per line out, until stdin closes."""
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        if not line.strip():
            continue
        try:
            response = dispatch(json.loads(line))
        except Exception as error:
            response = {"error": str(error) or error.__class__.__name__}
        json.dump(response, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        sys.stdout.flush()


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    json.dump(dispatch(json.load(sys.stdin)), sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
