/**
 * M3.25 — Connector field coverage gap report
 * Identifies optional fields with no default value hint as coverage gaps.
 */

import { listSchemaConnectorIds, getConnectorSchema } from './connector_schema';

export interface FieldCoverageGap {
  connector_id: string;
  field_name: string;
  field_type: string;
  gap_reason: 'optional_no_default' | 'missing_sample';
}

export interface ConnectorFieldCoverageGapReport {
  generated_at: string;
  total_connectors: number;
  total_gaps: number;
  gaps: FieldCoverageGap[];
  connectors_with_gaps: string[];
}

export function buildConnectorFieldCoverageGap(
  now: Date = new Date(),
): ConnectorFieldCoverageGapReport {
  const gaps: FieldCoverageGap[] = [];
  const connectors_with_gaps_set = new Set<string>();

  const connector_ids = listSchemaConnectorIds();

  for (const connector_id of connector_ids) {
    const schema = getConnectorSchema(connector_id);
    if (!schema) continue;

    for (const field of schema.fields) {
      if (field.required) continue;

      const has_enum = field.enum_values && field.enum_values.length > 0;
      const has_range =
        field.min !== undefined ||
        field.max !== undefined ||
        field.max_length !== undefined;
      const has_sample = field.sample && field.sample.trim().length > 0;

      if (!has_enum && !has_range && !has_sample) {
        gaps.push({
          connector_id,
          field_name: field.name,
          field_type: field.type,
          gap_reason: 'optional_no_default',
        });
        connectors_with_gaps_set.add(connector_id);
      } else if (!has_sample) {
        gaps.push({
          connector_id,
          field_name: field.name,
          field_type: field.type,
          gap_reason: 'missing_sample',
        });
        connectors_with_gaps_set.add(connector_id);
      }
    }
  }

  // Sort by connector_id asc then field_name asc
  gaps.sort((a, b) => {
    if (a.connector_id !== b.connector_id) return a.connector_id.localeCompare(b.connector_id);
    return a.field_name.localeCompare(b.field_name);
  });

  const connectors_with_gaps = [...connectors_with_gaps_set].sort();

  return {
    generated_at: now.toISOString(),
    total_connectors: connector_ids.length,
    total_gaps: gaps.length,
    gaps,
    connectors_with_gaps,
  };
}
