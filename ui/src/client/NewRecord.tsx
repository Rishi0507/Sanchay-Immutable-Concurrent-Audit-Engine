import { useMemo, useState } from "react";
import { ToolInfo, callTool, idempotencyKey } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Empty, Field, Header, KeyValues, cx, inputClass, toast, useAction } from "../ui";
import { toolLabel } from "./Access";
import { fieldLabel, show } from "./Records";

// Files go through the Upload and Requests screens. The key is generated here.
const elsewhere = new Set(["upload_sales_register", "upload_related_parties", "upload_evidence"]);
const hidden = new Set(["idempotency_key", "content_base64"]);

type Schema = ToolInfo["input_schema"]["properties"][string];

function isJson(s: Schema) {
  return s.type === "array" || s.type === "object";
}

function Input({ schema, value, onChange }: { schema: Schema; value: string; onChange: (v: string) => void }) {
  if (schema.enum)
    return (
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" />
        {schema.enum.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    );
  if (isJson(schema))
    return <textarea className={inputClass + " h-auto min-h-16 py-2 font-mono text-xs"} placeholder={schema.type === "array" ? "[ ]" : "{ }"} value={value} onChange={(e) => onChange(e.target.value)} />;
  const type = schema.format === "date" ? "date" : schema.format === "date-time" ? "datetime-local" : schema.type === "number" || schema.type === "integer" ? "number" : "text";
  return <input className={inputClass} type={type} step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
}

// Turns what was typed into the value the tool expects. Empty fields are left out.
function parse(schema: Schema, text: string): unknown {
  if (isJson(schema)) return JSON.parse(text);
  if (schema.type === "number" || schema.type === "integer") return Number(text);
  if (schema.format === "date-time") return new Date(text).toISOString().replace(/\.\d{3}Z$/, "Z");
  return text;
}

// One form for every record a department may create. The list comes from the
// server, so a person sees only the steps their department owns.
export default function NewRecord({ tools }: ViewProps) {
  const actions = useMemo(() => tools.filter((t) => t.write && !elsewhere.has(t.name)), [tools]);
  const [name, setName] = useState(actions[0]?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const [done, setDone] = useState<Record<string, unknown> | null>(null);
  const { busy, run } = useAction();
  const tool = actions.find((t) => t.name === name);

  if (!tool)
    return (
      <>
        <Header title="New record" />
        <Card>
          <Empty title="This identity cannot create records" hint="The Access tab shows which department owns each step." />
        </Card>
      </>
    );

  const pick = (next: string) => {
    setName(next);
    setValues({});
    setMore(false);
    setDone(null);
  };

  const required = new Set(tool.input_schema.required ?? []);
  const fields = Object.entries(tool.input_schema.properties).filter(([k]) => !hidden.has(k));
  const shown = fields.filter(([k]) => more || required.has(k));
  const optional = fields.length - fields.filter(([k]) => required.has(k)).length;
  const missing = [...required].some((k) => !hidden.has(k) && !values[k]);

  const submit = () =>
    run("submit", async () => {
      const args: Record<string, unknown> = { idempotency_key: idempotencyKey(tool.name) };
      for (const [k, schema] of fields) {
        if (!values[k]) continue;
        try {
          args[k] = parse(schema, values[k]);
        } catch {
          throw new Error(`${fieldLabel(k)} is not valid JSON.`);
        }
      }
      setDone(await callTool(tool.name, args));
      setValues({});
      toast("Recorded in the ledger.");
    });

  const groups = [...new Set(actions.map((t) => t.group))];

  return (
    <>
      <Header title="New record" hint="Each entry is appended to the ledger under your name. It cannot be edited afterwards, only reversed." />
      <div className="grid items-start gap-6 md:grid-cols-[240px_1fr]">
        <nav aria-label="Record types">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="mb-1 px-2 text-xs font-semibold text-ink-3">{g}</div>
              {actions
                .filter((t) => t.group === g)
                .map((t) => (
                  <button
                    key={t.name}
                    onClick={() => pick(t.name)}
                    aria-current={t.name === name ? "true" : undefined}
                    className={cx("block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors", t.name === name ? "bg-brand-wash font-medium text-brand" : "text-ink-2 hover:bg-wash hover:text-ink")}
                  >
                    {toolLabel(t.name)}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <Card className="p-6">
          <div className="text-base font-semibold">{toolLabel(tool.name)}</div>
          <p className="mt-1 mb-5 text-sm text-ink-2">{tool.description.split(". ")[0].replace(/\.$/, "")}.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {shown.map(([k, schema]) => (
              <div key={k} className={cx(isJson(schema) && "sm:col-span-2")} title={schema.description}>
                <Field label={fieldLabel(k).replace(/^./, (c) => c.toUpperCase()) + (required.has(k) ? "" : " (optional)")}>
                  <Input schema={schema} value={values[k] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
                </Field>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center gap-3">
            <Button busy={busy === "submit"} disabled={missing} onClick={submit}>
              Record
            </Button>
            {optional > 0 && (
              <Button kind="ghost" onClick={() => setMore((m) => !m)}>
                {more ? "Fewer fields" : `${optional} more fields`}
              </Button>
            )}
          </div>
          {done && (
            <div className="mt-6 border-t border-line-soft pt-5">
              <KeyValues
                items={Object.entries(done)
                  .filter(([, v]) => typeof v !== "object")
                  .map(([k, v]) => [fieldLabel(k), show(k, v)] as [string, string])}
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
