import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRegistry, extractToc, findDoc, neighbors, parseMeta, PLAN_FILE, plainText, rewriteDocLink } from "../web/lib/docs-core.js";

// La documentación en la web (specs/doc-web.md): la lista, los metadatos, el índice y los links, sin navegador.

const specFiles = readdirSync("specs");
const registry = buildRegistry(specFiles);

describe("la lista de documentos (R2, R6)", () => {
  it("tiene README, plan, una página por fase (en orden) y las de referencia", () => {
    const slugs = registry.map((d) => d.slug);
    expect(slugs.slice(0, 2)).toEqual(["inicio", "plan"]);
    const phases = registry.filter((d) => d.group === "phase");
    expect(phases.length).toBeGreaterThanOrEqual(9);
    expect(phases.map((d) => d.phase)).toEqual([...phases.map((d) => d.phase!)].sort((a, b) => a - b));
    expect(phases[0]).toMatchObject({ slug: "fase-01", file: "specs/fase-01-entorno.md", label: "Fase 1" });
    expect(slugs).toContain("mapa-del-grafo");
    expect(slugs).toContain("doc-web");
    expect(slugs).toContain("ramas-del-hilo");
    expect(findDoc(registry, "plan")?.file).toBe(PLAN_FILE);
  });

  it("una fase nueva aparece sola; los archivos que no son fases no", () => {
    const more = buildRegistry(["fase-01-entorno.md", "fase-10-errores-reintentos.md", "notas.md", "fase-1-mal.md", "mapa-del-grafo.md"]);
    expect(more.filter((d) => d.group === "phase").map((d) => d.slug)).toEqual(["fase-01", "fase-10"]);
  });

  it("un nombre fuera de la lista no es un documento (nunca se usa como ruta)", () => {
    for (const slug of ["../.env", "..%2F.env", "fase-99", "README.md", "specs/fase-01-entorno.md", ""]) expect(findDoc(registry, slug)).toBeUndefined();
  });

  it("todos los archivos de la lista existen", () => {
    for (const d of registry) expect(() => readFileSync(d.file, "utf8"), d.file).not.toThrow();
  });
});

describe("metadatos de un documento (R1)", () => {
  it("título, estado, objetivo, diagramas y tiempo de lectura de una spec real", () => {
    const meta = parseMeta(readFileSync("specs/fase-09-streaming-web.md", "utf8"), "Fase 9");
    expect(meta.title).toBe("Fase 9: Streaming y chat web");
    expect(meta.status).toBe("terminada");
    expect(meta.objective).toMatch(/^Usar el copiloto desde un chat web/);
    expect(meta.objective).not.toMatch(/\*\*/);
    expect(meta.diagrams).toBe(5);
    expect(meta.readingMinutes).toBeGreaterThan(5);
  });

  it("sin título, estado ni objetivo: el nombre de respaldo y nada más", () => {
    expect(parseMeta("texto suelto", "Inicio")).toMatchObject({ title: "Inicio", status: undefined, objective: undefined, diagrams: 0, readingMinutes: 1 });
  });

  it("lo que está dentro de un bloque de código no cuenta", () => {
    const md = "```\n# No es título\nEstado: **falso**\n```\n# Título real\n";
    expect(parseMeta(md, "x")).toMatchObject({ title: "Título real", status: undefined });
  });

  it("plainText saca código, énfasis y links", () => {
    expect(plainText("Fase 1: un nodo (`fase-01`) y **negrita** con [link](a.md)")).toBe("Fase 1: un nodo (fase-01) y negrita con link");
  });
});

describe("índice «En esta página» (R4)", () => {
  it("toma ## y ###, ignora los de los bloques de código y repite ids como rehype-slug", () => {
    const md = ["# Título", "## Objetivo", "texto", "```", "## No", "```", "### Un **detalle**", "## Objetivo", "#### Muy adentro"].join("\n");
    expect(extractToc(md)).toEqual([
      { depth: 2, text: "Objetivo", id: "objetivo" },
      { depth: 3, text: "Un detalle", id: "un-detalle" },
      { depth: 2, text: "Objetivo", id: "objetivo-1" },
    ]);
  });

  it("los títulos con código y acentos llevan el id que les pone rehype-slug", () => {
    expect(extractToc("## Fase 4: el grafo recuerda por hilo (`fase-04`)\n## Qué aprendí")).toEqual([
      { depth: 2, text: "Fase 4: el grafo recuerda por hilo (fase-04)", id: "fase-4-el-grafo-recuerda-por-hilo-fase-04" },
      { depth: 2, text: "Qué aprendí", id: "qué-aprendí" },
    ]);
  });
});

describe("links entre documentos (R4) y anterior/siguiente", () => {
  it("un link a otro documento lleva a su página de /doc; los demás quedan igual", () => {
    expect(rewriteDocLink("specs/fase-04-persistencia.md", registry)).toBe("/doc/fase-04");
    expect(rewriteDocLink("../README.md#comandos", registry)).toBe("/doc/inicio#comandos");
    expect(rewriteDocLink("mapa-del-grafo.md", registry)).toBe("/doc/mapa-del-grafo");
    expect(rewriteDocLink("doc/Plan%20Copiloto%20de%20gesti%C3%B3n%20con%20LangGraph%20(SDD).md", registry)).toBe("/doc/plan");
    expect(rewriteDocLink("https://docs.langchain.com/x.md", registry)).toBe("https://docs.langchain.com/x.md");
    expect(rewriteDocLink("#objetivo", registry)).toBe("#objetivo");
    expect(rewriteDocLink("src/graph/index.ts", registry)).toBe("src/graph/index.ts");
    expect(rewriteDocLink("otra-cosa.md", registry)).toBe("otra-cosa.md");
  });

  it("anterior y siguiente recorren las fases en orden", () => {
    expect(neighbors(registry, "fase-01")).toMatchObject({ previous: { slug: "plan" }, next: { slug: "fase-02" } });
    expect(neighbors(registry, "inicio").previous).toBeUndefined();
    expect(neighbors(registry, "no-existe")).toEqual({});
  });
});
