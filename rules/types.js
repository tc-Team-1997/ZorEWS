"use strict";
// rules/types.ts
// TypeScript types mirroring rules/dsl.schema.json.
// Keep in sync with the JSON Schema. Both are authoritative; the schema is the
// runtime validator (AJV) and these types are for compile-time consumers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCmp = isCmp;
exports.isAnd = isAnd;
exports.isOr = isOr;
exports.isNot = isNot;
// ---- Type guards ----
function isCmp(e) {
    return e.indicator !== undefined && e.op !== undefined;
}
function isAnd(e) {
    return Array.isArray(e.and);
}
function isOr(e) {
    return Array.isArray(e.or);
}
function isNot(e) {
    return e.not !== undefined && !isAnd(e) && !isOr(e);
}
