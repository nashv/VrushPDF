/**
 * Form widgets as pdf.js sees them, and the annotation-storage entries that
 * make its renderer draw a filled-in value.
 *
 * Pages render with `ENABLE_STORAGE` (see `render.ts`), and in that mode pdf.js
 * regenerates a widget's appearance from whatever the storage holds for it.
 * So the canvas shows each field exactly as the saved file will, and the form
 * layer above it only needs real inputs while one is being typed into.
 */
import type { FieldKind, FieldValue } from "$lib/annotations/fields";
import type { Rect } from "$lib/annotations/types";
import type { PDFPageProxy } from "./pdfjs";

export interface ChoiceOption {
  exportValue: string;
  displayValue: string;
}

export interface FormWidget {
  /** pdf.js annotation id, e.g. `"12R"`: the storage key. */
  id: string;
  /** Fully qualified field name, shared by every widget of the field. */
  name: string;
  kind: FieldKind;
  /** PDF user space. */
  rect: Rect;
  /** What the file says, before any filling. */
  initial: FieldValue;
  multiline: boolean;
  maxLength: number | null;
  /** Points; 0 means "fit the box", as in the PDF's `/DA`. */
  fontSize: number;
  align: "left" | "center" | "right";
  /** Checkbox or radio: the state name this widget turns on. */
  onValue: string | null;
  options: ChoiceOption[];
  /** Choice: a dropdown rather than a list. */
  combo: boolean;
  multiSelect: boolean;
}

/** The subset of pdf.js's widget annotation data this reads. */
interface WidgetData {
  id: string;
  subtype: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  rect: number[];
  readOnly?: boolean;
  hidden?: boolean;
  noHTML?: boolean;
  multiLine?: boolean;
  maxLen?: number;
  textAlignment?: number;
  defaultAppearanceData?: { fontSize?: number };
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: ChoiceOption[];
  combo?: boolean;
  multiSelect?: boolean;
}

function kindOf(a: WidgetData): FieldKind | null {
  switch (a.fieldType) {
    case "Tx":
      return "text";
    case "Btn":
      if (a.checkBox) return "checkbox";
      if (a.radioButton) return "radio";
      return null; // push buttons do nothing without JavaScript
    case "Ch":
      return "choice";
    default:
      return null; // signature fields have their own workflow
  }
}

function initialValue(kind: FieldKind, a: WidgetData): FieldValue {
  const v = a.fieldValue;
  switch (kind) {
    case "text":
      return typeof v === "string" ? v : "";
    case "checkbox":
      return typeof v === "string" && v !== "Off" && v === a.exportValue;
    case "radio":
      return typeof v === "string" && v !== "Off" ? v : null;
    case "choice":
      return Array.isArray(v) ? v.map(String) : typeof v === "string" && v !== "" ? [v] : [];
  }
}

/** The fillable widgets on `page`. Read-only, hidden and button-less ones are left to the canvas. */
export async function loadWidgets(page: PDFPageProxy): Promise<FormWidget[]> {
  const annotations = (await page.getAnnotations({ intent: "display" })) as WidgetData[];
  const widgets: FormWidget[] = [];
  for (const a of annotations) {
    if (a.subtype !== "Widget" || !a.fieldName || a.readOnly || a.hidden || a.noHTML) continue;
    const kind = kindOf(a);
    if (!kind) continue;
    const [x1, y1, x2, y2] = a.rect;
    widgets.push({
      id: a.id,
      name: a.fieldName,
      kind,
      rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
      initial: initialValue(kind, a),
      multiline: !!a.multiLine,
      maxLength: a.maxLen && a.maxLen > 0 ? a.maxLen : null,
      fontSize: a.defaultAppearanceData?.fontSize ?? 0,
      align: a.textAlignment === 1 ? "center" : a.textAlignment === 2 ? "right" : "left",
      onValue: kind === "checkbox" ? (a.exportValue ?? null) : kind === "radio" ? (a.buttonValue ?? null) : null,
      options: a.options ?? [],
      combo: !!a.combo,
      multiSelect: !!a.multiSelect,
    });
  }
  return widgets;
}

/** The storage entry that makes pdf.js draw `widget` showing `value`. */
export function storageEntry(widget: FormWidget, value: FieldValue): { value: string | boolean | string[] } {
  switch (widget.kind) {
    case "text":
      return { value: typeof value === "string" ? value : "" };
    case "checkbox":
      return { value: value === true };
    case "radio":
      // Each radio widget is stored separately: on if it is the chosen one.
      return { value: value !== null && value === widget.onValue };
    case "choice": {
      const selected = Array.isArray(value) ? value : [];
      return { value: widget.multiSelect ? selected : (selected[0] ?? "") };
    }
  }
}

/** Whether `value` shows the same thing as the file's own `initial`. */
export function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}
