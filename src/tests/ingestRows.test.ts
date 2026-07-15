import { describe, expect, it } from "vitest";
import {
  chunkRows,
  projectRowsForSchema,
  schemaKeysFromFeed,
  SSRM_INGEST_CHUNK_SIZE,
} from "../ssrm/ingestRows";

describe("projectRowsForSchema", () => {
  it("keeps only schema keys", () => {
    const rows = [
      { id: "1", assetClass: "Rates", unused: [1, 2, 3], fat: "x".repeat(100) },
      { id: "2", assetClass: "CorpIG", unused: [], fat: "y" },
    ];
    const out = projectRowsForSchema(rows, ["id", "assetClass"]);
    expect(out).toEqual([
      { id: "1", assetClass: "Rates" },
      { id: "2", assetClass: "CorpIG" },
    ]);
  });
});

describe("chunkRows", () => {
  it("uses the default ingest chunk size", () => {
    expect(SSRM_INGEST_CHUNK_SIZE).toBe(2_500);
  });

  it("returns a single chunk when under the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
    expect(chunkRows(rows, 2_500)).toHaveLength(1);
  });

  it("splits large books into progressive chunks", () => {
    const rows = Array.from({ length: 6_000 }, (_, i) => ({ id: String(i) }));
    const chunks = chunkRows(rows, 2_500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2_500);
    expect(chunks[1]).toHaveLength(2_500);
    expect(chunks[2]).toHaveLength(1_000);
  });
});

describe("schemaKeysFromFeed", () => {
  it("includes the index when missing from schema", () => {
    expect(schemaKeysFromFeed({ assetClass: "string" }, "id").sort()).toEqual([
      "assetClass",
      "id",
    ]);
  });
});
