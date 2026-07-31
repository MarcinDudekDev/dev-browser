// Fill form field(s) by ref (e5), name, or label
// Usage: fill <ref|field> <value>  OR  fill "field=value"  OR  fill "field1=val1 field2=val2"
import { resolveField, smartFill } from "@/resolve-field.js";

const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: fill <ref|field> <value>");
    console.error("Examples: fill e5 hello | fill email test@x.com | fill 'log=admin pwd=secret'");
    process.exit(1);
}

// Parse multi-field format: "field1=val1 field2='val with = signs' field3=val3"
// Supports quoted values (single or double quotes) for values containing =
// Unquoted values consume up to the next key= boundary (spaces preserved)
function parseKV(input: string): Array<{ key: string; val: string }> {
    const pairs: Array<{ key: string; val: string }> = [];
    const re = /([a-zA-Z_][\w-]*)=((?:'[^']*'|"[^"]*"|(?:[^\s]|\s(?![a-zA-Z_][\w-]*=)))*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
        let val = m[2]!;
        if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
            val = val.slice(1, -1);
        }
        pairs.push({ key: m[1]!, val });
    }
    return pairs;
}
const kvPairs = parseKV(args);
const isMultiField = kvPairs.length >= 2;

// Check if single legacy format: "field=value" (no spaces in field name)
const isSingleLegacy = !isMultiField && args.includes("=") && !args.startsWith("e") && /^[a-zA-Z_][\w-]*=/.test(args);

if (isMultiField) {
    // Multi-field format: "log=admin pwd=secret123 email=test@x.com"
    const filledFields: string[] = [];
    const failedFields: string[] = [];

    for (const { key: field, val } of kvPairs) {
        const resolved = await resolveField(page, field);
        if (resolved) {
            await smartFill(resolved, val);
            filledFields.push(field);
        } else {
            failedFields.push(field);
        }
    }

    // Output results
    if (filledFields.length > 0) console.log("Filled:", filledFields.join(", "));
    if (failedFields.length > 0) console.error("Not found:", failedFields.join(", "));

    // Compact page state showing current form values
    const state = await page.evaluate(() => {
      const doc = document;
      const lines: string[] = [];
      lines.push(`URL: ${location.href}`);
      const forms = doc.querySelectorAll("form");
      forms.forEach((form) => {
        const id = form.id || form.getAttribute("name") || "(unnamed)";
        const fields: string[] = [];
        form.querySelectorAll("input, select, textarea").forEach((el) => {
          const inp = el as HTMLInputElement;
          const name = inp.name || inp.id || inp.placeholder || inp.type;
          if (name && inp.type !== "hidden") {
            const val = inp.value ? ` ="${inp.value.substring(0, 20)}"` : "";
            fields.push(`${name}[${inp.type || el.tagName.toLowerCase()}]${val}`);
          }
        });
        if (fields.length > 0) lines.push(`Form #${id}: ${fields.join(", ")}`);
      });
      const buttons: string[] = [];
      doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((el) => {
        const text = (el.textContent || (el as HTMLInputElement).value || "").trim().substring(0, 30);
        if (text && !buttons.includes(text)) buttons.push(text);
      });
      if (buttons.length > 0) lines.push(`Buttons: ${buttons.slice(0, 8).join(", ")}`);
      return lines.join("\n");
    });
    console.log(state);

    if (failedFields.length > 0) process.exit(1);
} else {
    // Single field mode: ref, new format, or legacy format
    let target: string;
    let value: string;

    if (isSingleLegacy) {
        const eqIdx = args.indexOf("=");
        target = args.slice(0, eqIdx);
        value = args.slice(eqIdx + 1);
    } else {
        const spaceIdx = args.indexOf(" ");
        if (spaceIdx === -1) {
            console.error("Usage: fill <ref|field> <value>");
            process.exit(1);
        }
        target = args.slice(0, spaceIdx);
        value = args.slice(spaceIdx + 1);
    }

    // Check if target is an ARIA ref (e.g., e1, e5, e123)
    const isRef = /^e\d+$/.test(target);

    if (isRef) {
        try {
            const pageName = process.env.PAGE_NAME || "main";
            const prefix = process.env.PROJECT_PREFIX || "dev";
            const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
            await element.fill(value);
            console.log(JSON.stringify({ filled: target, value, type: "ref" }));
        } catch (e: any) {
            const msg = e.message?.includes("Timeout")
                ? `Ref '${target}' found but not fillable (hidden, disabled, or covered)`
                : `Ref '${target}' not found. Run 'aria' to see available refs.`;
            console.error(JSON.stringify({ error: msg }));
            process.exit(1);
        }
    } else {
        const resolved = await resolveField(page, target);
        if (!resolved) {
            console.error(JSON.stringify({ error: `Field '${target}' not found` }));
            process.exit(1);
        }

        const action = await smartFill(resolved, value);
        console.log(JSON.stringify({ filled: target, value, selector: resolved.matchedBy, action }));
    }
}
