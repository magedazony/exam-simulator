"""Checks the API contract for structural errors and answer-key leaks.

Run:  python3 api/check_contract.py api/openapi.yaml
Exits with a non-zero status when a check fails, so it can gate a build.
Needs PyYAML.
"""
import re
import sys

import yaml

# Operations a candidate can call before a question is answered (practice) or
# before an attempt is finished (mock). Their success responses must never
# carry a key, a rationale, an explanation or a database id of a question.
PRE_ANSWER_OPERATIONS = {
    "startPracticeSession",
    "getPracticeQuestion",
    "startAttempt",
    "getAttempt",
    "getSectionQuestions",
    "saveAnswer",
    "getSectionReview",
    "closeSection",
    "resumeFromBreak",
}
FORBIDDEN = re.compile(r"correct|rationale|explanation|feedback|questionid|versionid|publiccode", re.I)
METHODS = {"get", "put", "post", "patch", "delete"}


def resolve(doc, ref):
    node = doc
    for part in ref.lstrip("#/").split("/"):
        node = node[part]
    return node


def walk_refs(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref":
                found.append(value)
            else:
                walk_refs(value, found)
    elif isinstance(node, list):
        for value in node:
            walk_refs(value, found)


def property_names(doc, schema, seen, out):
    """Collects every property name reachable from a schema, following refs."""
    if isinstance(schema, list):
        for item in schema:
            property_names(doc, item, seen, out)
        return
    if not isinstance(schema, dict):
        return
    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in seen:
            return
        seen.add(ref)
        property_names(doc, resolve(doc, ref), seen, out)
        return
    for name, sub in (schema.get("properties") or {}).items():
        out.add(name)
        property_names(doc, sub, seen, out)
    for key in ("items", "additionalProperties", "allOf", "oneOf", "anyOf"):
        if key in schema:
            property_names(doc, schema[key], seen, out)


def main(path):
    with open(path, encoding="utf-8") as handle:
        doc = yaml.safe_load(handle)
    errors = []

    refs = []
    walk_refs(doc, refs)
    for ref in refs:
        try:
            resolve(doc, ref)
        except (KeyError, TypeError):
            errors.append(f"unresolved reference {ref}")

    operation_ids = {}
    for route, item in doc["paths"].items():
        for method, op in item.items():
            if method not in METHODS:
                continue
            op_id = op.get("operationId")
            if not op_id:
                errors.append(f"{method.upper()} {route} has no operationId")
                continue
            if op_id in operation_ids:
                errors.append(f"duplicate operationId {op_id}")
            operation_ids[op_id] = (route, method, op)

            declared = set()
            for param in op.get("parameters", []):
                if "$ref" in param:
                    param = resolve(doc, param["$ref"])
                if param.get("in") == "path":
                    declared.add(param["name"])
            needed = set(re.findall(r"{(\w+)}", route))
            if needed != declared:
                errors.append(f"{method.upper()} {route}: path parameters {sorted(needed)} vs declared {sorted(declared)}")

            if route.startswith("/admin/") and not op.get("x-roles"):
                errors.append(f"{method.upper()} {route}: admin operation without x-roles")
            if not any(code.startswith("2") for code in op.get("responses", {})):
                errors.append(f"{method.upper()} {route}: no success response")

    for op_id in sorted(PRE_ANSWER_OPERATIONS):
        if op_id not in operation_ids:
            errors.append(f"expected operation {op_id} is missing")
            continue
        _, _, op = operation_ids[op_id]
        for code, response in op["responses"].items():
            if not code.startswith("2"):
                continue
            names = set()
            property_names(doc, response.get("content", {}), set(), names)
            for media in (response.get("content") or {}).values():
                property_names(doc, media.get("schema", {}), set(), names)
            leaked = sorted(n for n in names if FORBIDDEN.search(n))
            if leaked:
                errors.append(f"{op_id}: response {code} exposes {leaked}")

    closed = ["CandidateQuestion", "CandidateOption", "SectionQuestions", "CaseStudyView", "SavedAnswerView"]
    for name in closed:
        if doc["components"]["schemas"][name].get("additionalProperties") is not False:
            errors.append(f"schema {name} must set additionalProperties: false")

    print(f"{len(doc['paths'])} paths, {len(operation_ids)} operations, "
          f"{len(doc['components']['schemas'])} schemas, {len(refs)} references")
    if errors:
        print("FAILED")
        for error in errors:
            print(" -", error)
        return 1
    print("OK: references resolve, path parameters match, no key or id exposed before answering")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "api/openapi.yaml"))
