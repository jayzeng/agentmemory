import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const documentPath = join(import.meta.dir, "../../ecosystem.html");
const html = readFileSync(documentPath, "utf8");

function matches(pattern: RegExp): string[] {
	return [...html.matchAll(pattern)].map((match) => match[1]);
}

describe("ecosystem architecture document", () => {
	test("keeps decision, security, delivery, and source sections addressable", () => {
		const ids = matches(/\bid="([^"]+)"/g);
		const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
		const internalLinks = matches(/\bhref="#([^"]+)"/g);

		expect(duplicateIds).toEqual([]);
		for (const required of ["decisions", "threats", "mvp", "sources"]) expect(ids).toContain(required);
		for (const target of internalLinks) expect(ids).toContain(target);
	});

	test("links the runnable slice and preserves its documented command", () => {
		expect(html).toContain('href="ecosystem-reference/README.md"');
		expect(html).toContain("npm run test:ecosystem");
		expect(html).toContain("conversation → channel → workspace");
	});

	test("keeps baseline accessibility and diagram fallbacks", () => {
		expect(html).toContain('<a class="skip-link" href="#main">');
		expect(html).toContain('<main id="main" tabindex="-1">');
		expect(html).toContain("@media (prefers-reduced-motion: reduce)");
		expect(matches(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)).toHaveLength(10);
		expect(html).toContain("<noscript>");
	});
});
