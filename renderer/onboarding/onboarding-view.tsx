/**
 * First-run finance preferences.
 *
 * Prefilled with India defaults; the user reviews and (optionally) edits them
 * before the app begins serious analysis. Saving persists the preferences and
 * marks first-run complete. These same values are editable later in Settings.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Text,
} from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { CalendarClock, Coins, Hash, Landmark, Sparkles } from "lucide-react";
import {
  financialYearKey,
  formatDatePref,
  fyLabel,
  INDIA_DEFAULTS,
  MONTH_NAMES,
  type DateFormat,
  type FinancePrefs,
} from "../finance";

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  window.glazeAPI.glaze.ipc.invoke<T>(channel, ...args);

const DATE_FORMATS: DateFormat[] = ["DD-MM-YYYY", "DD MMM YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

function Field({ icon, label, hint, children }: { icon: ReactNode; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-tertiary">{icon}</span>
        <Text variant="small-strong">{label}</Text>
      </div>
      {children}
      {hint ? (
        <Text variant="small" color="tertiary">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

export function OnboardingView() {
  useTheme();
  const prefsQuery = useQuery({ queryKey: ["financePrefs"], queryFn: () => invoke<FinancePrefs>("prefs:get") });
  const base = prefsQuery.data ?? INDIA_DEFAULTS;

  const [currency, setCurrency] = useState(base.currency);
  const [fyStartMonth, setFyStartMonth] = useState(String(base.fyStartMonth));
  const [dateFormat, setDateFormat] = useState<DateFormat>(base.dateFormat);
  const [grouping, setGrouping] = useState(base.grouping);
  const [saving, setSaving] = useState(false);

  const month = Number(fyStartMonth) || 4;
  const previewPrefs: FinancePrefs = { ...base, currency, dateFormat, grouping, fyStartMonth: month };
  const dateExample = formatDatePref("2026-03-31", previewPrefs);
  const fyMar = fyLabel(financialYearKey("2026-03-31", month));
  const fyApr = fyLabel(financialYearKey("2026-04-01", month));

  const save = async () => {
    setSaving(true);
    const patch: Partial<FinancePrefs> = {
      currency: currency.trim().toUpperCase() || "INR",
      dateFormat,
      grouping,
      decimalSeparator: ".",
      thousandsSeparator: ",",
      fyStartMonth: month,
    };
    try {
      await invoke("onboarding:complete", patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full w-full overflow-auto">
      <div className="mx-auto flex max-w-md flex-col gap-5 px-6 py-7">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-contrast">
              <Sparkles className="size-4" />
            </span>
            <Text variant="heading2">Welcome to Quick2Afvault</Text>
          </div>
          <Text variant="small" color="secondary">
            A few financial preferences so the app is grounded from the start. These are prefilled with India
            defaults — review them and change anything you like. You can edit them again any time in Settings.
          </Text>
        </div>

        <Separator />

        <Field icon={<Coins className="size-4" />} label="Currency" hint="Your vault reports values in this currency.">
          <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="INR" className="w-32" />
        </Field>

        <Field
          icon={<CalendarClock className="size-4" />}
          label="Financial year start"
          hint={`A document dated 31 Mar 2026 → ${fyMar}; dated 1 Apr 2026 → ${fyApr}.`}
        >
          <Select value={fyStartMonth} onValueChange={setFyStartMonth}>
            <SelectTrigger variant="filled" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((name, i) => (
                <SelectItem key={name} value={String(i + 1)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field icon={<CalendarClock className="size-4" />} label="Date format" hint={`Example: ${dateExample}`}>
          <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as DateFormat)}>
            <SelectTrigger variant="filled" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          icon={<Hash className="size-4" />}
          label="Number format"
          hint={grouping === "indian" ? "Indian grouping: 1,23,456.78" : "International grouping: 1,234,567.89"}
        >
          <Select value={grouping} onValueChange={(v) => setGrouping(v as FinancePrefs["grouping"])}>
            <SelectTrigger variant="filled" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="indian">Indian (1,23,456.78)</SelectItem>
              <SelectItem value="western">International (1,234,567.89)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Separator />

        <div className="flex items-center gap-2">
          <Landmark className="size-3.5 text-tertiary shrink-0" />
          <Text variant="small" color="tertiary">
            The financial year is a core classification — every dated document is filed into its FY bucket.
          </Text>
        </div>

        <Button variant="accent" className="w-full" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Get started"}
        </Button>
      </div>
    </div>
  );
}
