{#
  Override dbt's default `generate_schema_name` so that a `+schema:` config
  on a model/seed becomes the LITERAL schema name (`raw`, `staging`, `mart`)
  instead of the default `<target>_<custom>` concatenation.

  The default behaviour produced `staging_raw.seed_loans` etc., which broke
  source resolution (sources point at `raw.seed_loans`).
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ custom_schema_name | trim }}
    {%- endif -%}
{%- endmacro %}
