// web/src/modules/reports/builder/FilterTreeBuilder.tsx
//
// T4.6.5 — Recursive FilterNode AST builder. Walks the discriminated
// union from T4.6.2 (AND/OR/NOT/leaf) and renders an editable tree.
// Field whitelist + value-type validation happens server-side via
// /v1/reports/builder/preview; this component constrains the UI to
// the catalog's `filterable` fields + per-field type-appropriate
// inputs.

import { Plus, Trash2 } from 'lucide-react';
import { Input, Button } from '@/components/ui';
import type { FilterNode, FilterOp, ReportDataSource, ReportField } from './api';

interface Props {
  source: ReportDataSource;
  node?: FilterNode;
  onChange: (node: FilterNode | undefined) => void;
}

const OPS_BY_TYPE: Record<string, readonly FilterOp[]> = {
  string: ['eq', 'ne', 'in', 'not_in', 'is_null', 'is_not_null'],
  integer: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
  number: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'is_null', 'is_not_null'],
  boolean: ['eq', 'ne', 'is_null', 'is_not_null'],
  date: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'is_null', 'is_not_null'],
  datetime: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'is_null', 'is_not_null'],
  enum: ['eq', 'ne', 'in', 'not_in', 'is_null', 'is_not_null'],
};

const OP_LABELS: Record<FilterOp, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
  in: 'in',
  not_in: 'not in',
  between: 'between',
  is_null: 'is null',
  is_not_null: 'is not null',
};

function defaultValueFor(field: ReportField, op: FilterOp): unknown {
  if (op === 'is_null' || op === 'is_not_null') return undefined;
  if (op === 'in' || op === 'not_in') return [];
  if (op === 'between') return field.type === 'string' || field.type === 'enum' || field.type === 'boolean'
    ? null
    : [0, 0];
  switch (field.type) {
    case 'boolean': return false;
    case 'integer': return 0;
    case 'number': return 0;
    case 'string': return '';
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'datetime': return new Date().toISOString();
    case 'enum': return field.enum_values?.[0] ?? '';
  }
}

function FilterLeaf({
  source,
  node,
  onChange,
}: {
  source: ReportDataSource;
  node: Extract<FilterNode, { op: FilterOp; field: string }>;
  onChange: (n: FilterNode) => void;
}): JSX.Element {
  const fields = source.fields.filter((f) => f.filterable);
  const field = source.fields.find((f) => f.name === node.field);

  const allowedOps = field ? OPS_BY_TYPE[field.type] ?? [] : [];

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filter-leaf">
      <select
        value={node.field}
        onChange={(e) => {
          const f = source.fields.find((x) => x.name === e.target.value);
          if (!f) return;
          const ops = OPS_BY_TYPE[f.type];
          const op = ops[0];
          onChange({ op, field: f.name, value: defaultValueFor(f, op) });
        }}
        aria-label="Field"
        className="text-xs border border-divider rounded px-2 py-1 bg-surface"
        data-testid="filter-field-select"
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.display_name} ({f.type})
          </option>
        ))}
      </select>

      <select
        value={node.op}
        onChange={(e) => {
          const newOp = e.target.value as FilterOp;
          if (!field) return;
          onChange({ op: newOp, field: node.field, value: defaultValueFor(field, newOp) });
        }}
        aria-label="Operator"
        className="text-xs border border-divider rounded px-2 py-1 bg-surface"
        data-testid="filter-op-select"
      >
        {allowedOps.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>

      {/* Value input(s) — shape depends on op + field.type. */}
      {field && node.op !== 'is_null' && node.op !== 'is_not_null' && (
        <ValueInput field={field} op={node.op} value={node.value} onChange={(v) => onChange({ ...node, value: v })} />
      )}
    </div>
  );
}

function ValueInput({
  field,
  op,
  value,
  onChange,
}: {
  field: ReportField;
  op: FilterOp;
  value: unknown;
  onChange: (v: unknown) => void;
}): JSX.Element {
  if (op === 'between') {
    const [lo, hi] = Array.isArray(value) ? value : [0, 0];
    return (
      <>
        <ScalarInput field={field} value={lo} onChange={(v) => onChange([v, hi])} testid="value-low" />
        <span className="text-xs text-ink-muted">to</span>
        <ScalarInput field={field} value={hi} onChange={(v) => onChange([lo, v])} testid="value-high" />
      </>
    );
  }
  if (op === 'in' || op === 'not_in') {
    const arr = Array.isArray(value) ? (value as unknown[]) : [];
    const enumVals = field.enum_values;
    if (enumVals && enumVals.length > 0) {
      return (
        <div className="flex flex-wrap gap-1" data-testid="value-multiselect">
          {enumVals.map((v) => {
            const checked = arr.includes(v);
            return (
              <label key={v} className="text-xs flex items-center gap-1 border border-divider rounded px-1.5 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked ? arr.filter((x) => x !== v) : [...arr, v];
                    onChange(next);
                  }}
                />
                {v}
              </label>
            );
          })}
        </div>
      );
    }
    // Comma-separated free-text for non-enum in-lists.
    const display = arr.join(', ');
    return (
      <Input
        value={display}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        placeholder="comma-separated"
        className="text-xs w-40"
        data-testid="value-csv"
      />
    );
  }
  return <ScalarInput field={field} value={value} onChange={onChange} testid="value-scalar" />;
}

function ScalarInput({
  field,
  value,
  onChange,
  testid,
}: {
  field: ReportField;
  value: unknown;
  onChange: (v: unknown) => void;
  testid: string;
}): JSX.Element {
  if (field.type === 'enum') {
    return (
      <select
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface"
        data-testid={testid}
      >
        {(field.enum_values ?? []).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select
        value={value === true ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === 'true')}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface"
        data-testid={testid}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.type === 'integer' || field.type === 'number') {
    return (
      <Input
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') return onChange(0);
          const num = field.type === 'integer' ? parseInt(v, 10) : parseFloat(v);
          if (!Number.isFinite(num)) return;
          onChange(num);
        }}
        className="text-xs w-28"
        data-testid={testid}
      />
    );
  }
  if (field.type === 'date') {
    return (
      <Input
        type="date"
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs"
        data-testid={testid}
      />
    );
  }
  if (field.type === 'datetime') {
    return (
      <Input
        type="datetime-local"
        value={typeof value === 'string' ? value.slice(0, 16) : ''}
        onChange={(e) => onChange(e.target.value + ':00.000Z')}
        className="text-xs"
        data-testid={testid}
      />
    );
  }
  return (
    <Input
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs w-40"
      data-testid={testid}
    />
  );
}

function FilterGroup({
  source,
  node,
  onChange,
  onDelete,
}: {
  source: ReportDataSource;
  node: Extract<FilterNode, { op: 'AND' | 'OR' }>;
  onChange: (n: FilterNode) => void;
  onDelete?: () => void;
}): JSX.Element {
  const children = node.children;
  return (
    <div className="border-l-2 border-brand-sky/40 pl-3 space-y-2" data-testid={`group-${node.op.toLowerCase()}`}>
      <div className="flex items-center gap-2">
        <select
          value={node.op}
          onChange={(e) => onChange({ op: e.target.value as 'AND' | 'OR', children })}
          className="text-xs font-semibold border border-divider rounded px-2 py-0.5 bg-surface"
          aria-label="Group operator"
          data-testid="group-op-select"
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const firstField = source.fields.find((f) => f.filterable);
            if (!firstField) return;
            const ops = OPS_BY_TYPE[firstField.type];
            const op = ops[0];
            onChange({
              op: node.op,
              children: [
                ...children,
                { op, field: firstField.name, value: defaultValueFor(firstField, op) },
              ],
            });
          }}
          data-testid="add-filter-btn"
        >
          <Plus className="h-3 w-3 mr-1" aria-hidden />
          Add filter
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange({
              op: node.op,
              children: [
                ...children,
                { op: 'AND', children: [] },
              ],
            });
          }}
          data-testid="add-group-btn"
        >
          + group
        </Button>
        {onDelete && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            aria-label="Delete group"
          >
            <Trash2 className="h-3 w-3 text-danger" aria-hidden />
          </Button>
        )}
      </div>
      {children.length === 0 && (
        <p className="text-xs text-ink-muted italic">No filters in this group</p>
      )}
      {children.map((child, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1">
            <FilterNodeRenderer
              source={source}
              node={child}
              onChange={(updated) => {
                const next = [...children];
                if (updated === undefined) {
                  next.splice(i, 1);
                } else {
                  next[i] = updated;
                }
                onChange({ op: node.op, children: next });
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              const next = [...children];
              next.splice(i, 1);
              onChange({ op: node.op, children: next });
            }}
            aria-label="Remove filter"
            className="text-danger hover:text-danger/70 mt-1"
            data-testid={`remove-child-${i}`}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

function FilterNodeRenderer({
  source,
  node,
  onChange,
}: {
  source: ReportDataSource;
  node: FilterNode;
  onChange: (n: FilterNode | undefined) => void;
}): JSX.Element {
  if (node.op === 'AND' || node.op === 'OR') {
    return <FilterGroup source={source} node={node} onChange={onChange} />;
  }
  if (node.op === 'NOT') {
    return (
      <div className="border-l-2 border-danger/40 pl-3" data-testid="group-not">
        <div className="text-xs font-semibold text-danger mb-1">NOT</div>
        <FilterNodeRenderer
          source={source}
          node={node.child}
          onChange={(child) =>
            child === undefined
              ? onChange(undefined)
              : onChange({ op: 'NOT', child })
          }
        />
      </div>
    );
  }
  return <FilterLeaf source={source} node={node} onChange={onChange} />;
}

export function FilterTreeBuilder({ source, node, onChange }: Props): JSX.Element {
  if (!node) {
    return (
      <div className="space-y-2" data-testid="filter-tree-empty">
        <p className="text-xs text-ink-muted italic">
          No filters — report returns all rows for this source.
        </p>
        <Button
          size="sm"
          onClick={() => {
            const firstField = source.fields.find((f) => f.filterable);
            if (!firstField) return;
            const ops = OPS_BY_TYPE[firstField.type];
            const op = ops[0];
            onChange({
              op: 'AND',
              children: [
                { op, field: firstField.name, value: defaultValueFor(firstField, op) },
              ],
            });
          }}
          data-testid="add-first-filter-btn"
        >
          <Plus className="h-3 w-3 mr-1" aria-hidden />
          Add first filter
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="filter-tree-root">
      <FilterNodeRenderer source={source} node={node} onChange={onChange} />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange(undefined)}
        data-testid="clear-filters-btn"
      >
        Clear all filters
      </Button>
    </div>
  );
}

export { OPS_BY_TYPE, defaultValueFor };
