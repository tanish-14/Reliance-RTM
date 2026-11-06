import { useEffect, useState, type FormEvent } from 'react';
import type { ZodTypeAny } from 'zod';
import { Button, ErrorNote, Input, Label, Select } from '../../components/ui';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'date';
  options?: { value: string; label: string }[];
  hint?: string;
  span?: 2;
}

/**
 * Small generic form: fields are strings in state, `toInput` maps them to the API shape,
 * and the shared zod schema validates on the client exactly as the server will.
 */
export function EntityForm({
  fields,
  initial,
  schema,
  toInput = (v) => v,
  onSubmit,
  submitLabel = 'Save',
}: {
  fields: Field[];
  initial: Record<string, string | boolean>;
  schema: ZodTypeAny;
  toInput?: (v: Record<string, any>) => unknown;
  onSubmit: (input: unknown) => Promise<unknown>;
  submitLabel?: string;
}) {
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(initial), [initial]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(false);
    const input = toInput(v);
    const r = schema.safeParse(input);
    if (!r.success) {
      setErrors(Object.fromEntries(r.error.issues.map((i: any) => [String(i.path[0] ?? 'form'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(input);
      setOk(true);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f.name} className={f.span === 2 || f.type === 'textarea' ? 'sm:col-span-2' : ''}>
          {f.type === 'checkbox' ? (
            <label className="flex items-center gap-2 pt-5 text-sm">
              <input type="checkbox" checked={!!v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} /> {f.label}
            </label>
          ) : (
            <>
              <Label>{f.label}</Label>
              {f.type === 'select' ? (
                <Select value={String(v[f.name] ?? '')} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>
                  <option value="">—</option>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : f.type === 'textarea' ? (
                <textarea
                  className="h-24 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-red-600"
                  value={String(v[f.name] ?? '')}
                  onChange={(e) => setV({ ...v, [f.name]: e.target.value })}
                />
              ) : (
                <Input type={f.type === 'number' ? 'text' : f.type ?? 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} value={String(v[f.name] ?? '')} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
              )}
            </>
          )}
          {f.hint && <div className="mt-0.5 text-xs text-slate-500">{f.hint}</div>}
          {errors[f.name] && <div className="mt-0.5 text-xs text-red-700">{errors[f.name]}</div>}
        </div>
      ))}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button>
        {ok && <span className="text-sm text-emerald-700">Saved ✓</span>}
        {errors.form && <span className="text-sm text-red-700">{errors.form}</span>}
      </div>
      <div className="sm:col-span-2"><ErrorNote error={err} /></div>
    </form>
  );
}
