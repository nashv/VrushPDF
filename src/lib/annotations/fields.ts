/**
 * Form fields: writing filled-in values into the saved PDF.
 *
 * Values are keyed by the field's fully qualified name, which is how both
 * pdf.js (`fieldName`) and pdf-lib (`getFieldMaybe`) identify a field, and is
 * shared by every widget of the field — two widgets named `Total` are one
 * field and always show the same value.
 *
 * Only the fields of the main document are fillable. A merged-in file's
 * widgets keep whatever they showed; their fields are not registered in the
 * saved document's form, so there is nothing to fill.
 *
 * Like the rest of `annotations/`, no Svelte or `$lib` imports, so
 * `scripts/verify-roundtrip.ts` can load this under plain Node.
 */
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFField,
  type PDFPage,
} from "pdf-lib";

export type FieldKind = "text" | "checkbox" | "radio" | "choice";

/**
 * What the user set a field to:
 * - text: the string
 * - checkbox: checked or not
 * - radio: the chosen button's on-state name, or null for none
 * - choice: the selected export values (one for a dropdown)
 */
export type FieldValue = string | boolean | string[] | null;

/** Filled-in values, by fully qualified field name. Absent means untouched. */
export type FieldValues = Record<string, FieldValue>;

export interface FieldWriteResult {
  written: number;
  /** Names of fields that were not found or would not take the value. */
  failed: string[];
}

/**
 * Set `values` on `doc`'s form and regenerate each changed field's appearance,
 * so every viewer shows the new value, not only the ones that honour
 * `/NeedAppearances`.
 *
 * The appearances use Helvetica, which only covers WinAnsi. A value outside it
 * (Greek, CJK, emoji) cannot be drawn that way; for those the field keeps the
 * value, `/NeedAppearances` asks the viewer to draw it, and the save goes on.
 */
export async function applyFieldValues(doc: PDFDocument, values: FieldValues): Promise<FieldWriteResult> {
  const result: FieldWriteResult = { written: 0, failed: [] };
  const names = Object.keys(values);
  if (names.length === 0) return result;

  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let needAppearances = false;

  for (const name of names) {
    const field = form.getFieldMaybe(name);
    const value = values[name];
    if (!field || !setValue(field, value)) {
      result.failed.push(name);
      continue;
    }
    result.written++;
    try {
      updateAppearance(field, font);
    } catch {
      needAppearances = true;
    }
  }

  if (needAppearances) {
    form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
  }
  return result;
}

function setValue(field: PDFField, value: FieldValue): boolean {
  try {
    if (field instanceof PDFTextField) {
      if (typeof value !== "string") return false;
      // pdf-lib refuses text over the field's limit; the UI enforces it too,
      // but a value typed before the limit was known is cut rather than lost.
      const max = field.getMaxLength();
      const text = max !== undefined ? value.slice(0, max) : value;
      field.setText(text === "" ? undefined : text);
      return true;
    }
    if (field instanceof PDFCheckBox) {
      if (typeof value !== "boolean") return false;
      if (value) field.check();
      else field.uncheck();
      return true;
    }
    if (field instanceof PDFRadioGroup) {
      // By on-state name, not `select()`: that takes `/Opt` labels when a field
      // has them, and pdf.js reports the appearance state names.
      if (value === null) field.clear();
      else if (typeof value === "string") field.acroField.setValue(PDFName.of(value));
      else return false;
      return true;
    }
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (!Array.isArray(value)) return false;
      // Export values straight onto the field: pdf-lib's `select()` checks
      // them against display labels, which differ whenever `/Opt` has pairs.
      if (value.length === 0) field.clear();
      else field.acroField.setValues(value.map((v) => PDFHexString.fromText(v)));
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function updateAppearance(field: PDFField, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) {
  if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) {
    field.updateAppearances(font);
  } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    // Buttons already carry on and off appearances; only `/AS` changes.
    field.defaultUpdateAppearances();
  }
}

/**
 * After a rebuild, make the main document's fields a form again.
 *
 * `copyPages` brings each page's widgets, and through `/Parent` their fields,
 * but not the document's `/AcroForm`, so the copy has widgets and no form: no
 * viewer would let anyone fill it, and `applyFieldValues` would find nothing.
 * This lists every field reachable from `pages` in a new `/AcroForm`, and
 * carries over the source's default appearance so field text keeps its font
 * size.
 */
export function registerFields(out: PDFDocument, source: PDFDocument, pages: PDFPage[]) {
  const roots = new Set<PDFRef>();
  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const dict = out.context.lookupMaybe(ref, PDFDict);
      if (dict?.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
      roots.add(rootField(out, ref, dict));
    }
  }
  if (roots.size === 0) return;

  const form = out.getForm().acroForm;
  const existing = new Set(form.getFields().map(([, ref]) => ref));
  for (const root of roots) if (!existing.has(root)) form.addField(root);

  const da = source.catalog.getAcroForm()?.dict.get(PDFName.of("DA"));
  if (da instanceof PDFString || da instanceof PDFHexString) form.dict.set(PDFName.of("DA"), da);
}

/** The top of a widget's field tree; the widget itself when it is the field. */
function rootField(doc: PDFDocument, ref: PDFRef, dict: PDFDict): PDFRef {
  let current = ref;
  let node = dict;
  // Bounded, in case a broken file has a `/Parent` cycle.
  for (let depth = 0; depth < 32; depth++) {
    const parent = node.get(PDFName.of("Parent"));
    if (!(parent instanceof PDFRef)) break;
    const parentDict = doc.context.lookupMaybe(parent, PDFDict);
    if (!parentDict) break;
    current = parent;
    node = parentDict;
  }
  return current;
}
