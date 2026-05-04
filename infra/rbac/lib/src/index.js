"use strict";
// infra/rbac/lib/src/index.ts
//
// Tiny RBAC helper. Loads the canonical matrix at infra/rbac/matrix.json
// and exposes `can(role, operation)`. Services import this for HTTP-level
// authorisation guards.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadMatrix = loadMatrix;
exports.resetMatrix = resetMatrix;
exports.can = can;
exports.operationsFor = operationsFor;
exports.requireRole = requireRole;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const DEFAULT_MATRIX_PATH = path.resolve(__dirname, '..', '..', 'matrix.json');
let _matrix = null;
let _matrixPath = DEFAULT_MATRIX_PATH;
function loadMatrix(matrixPath) {
    if (_matrix && (!matrixPath || matrixPath === _matrixPath))
        return _matrix;
    const p = matrixPath ?? _matrixPath;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const roles = raw.roles;
    if (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string')) {
        throw new Error(`${p}: roles must be a string[]`);
    }
    const ops = raw.operations;
    if (!ops || typeof ops !== 'object' || Array.isArray(ops)) {
        throw new Error(`${p}: operations must be an object`);
    }
    const roleSet = new Set(roles);
    for (const [op, allowed] of Object.entries(ops)) {
        if (!Array.isArray(allowed)) {
            throw new Error(`${p}: operation ${op} must list allowed roles`);
        }
        for (const a of allowed) {
            if (typeof a !== 'string' || !roleSet.has(a)) {
                throw new Error(`${p}: operation ${op} references unknown role: ${String(a)}`);
            }
        }
    }
    _matrix = raw;
    _matrixPath = p;
    return _matrix;
}
/** Test/dev helper. */
function resetMatrix() {
    _matrix = null;
    _matrixPath = DEFAULT_MATRIX_PATH;
}
/**
 * Authorisation check. Returns true iff `role` is allowed `operation` per the
 * canonical matrix. Unknown operations and unknown roles deny by default —
 * fail-closed is the right call for an HTTP guard.
 */
function can(role, operation, matrixPath) {
    const m = loadMatrix(matrixPath);
    const allowed = m.operations[operation];
    if (!allowed)
        return false;
    return allowed.includes(role);
}
/** All operations the role is granted, in matrix order. */
function operationsFor(role, matrixPath) {
    const m = loadMatrix(matrixPath);
    return Object.entries(m.operations)
        .filter(([, allowed]) => allowed.includes(role))
        .map(([op]) => op);
}
/** Express middleware factory: requires the request to carry a role attribute. */
function requireRole(operation, getRole) {
    return (req, res, next) => {
        const role = getRole(req);
        if (!role) {
            res.status(401).json({ error: 'authentication required' });
            return;
        }
        if (!can(role, operation)) {
            res.status(403).json({ error: `role ${role} cannot ${operation}` });
            return;
        }
        next();
    };
}
