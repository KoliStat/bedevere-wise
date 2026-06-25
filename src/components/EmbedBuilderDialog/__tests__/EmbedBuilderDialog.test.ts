import { afterEach, describe, expect, it } from "vitest";
import { EmbedBuilderDialog } from "../EmbedBuilderDialog";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EmbedBuilderDialog", () => {
  it("prefills the query and recomputes outputs on dataset input", () => {
    EmbedBuilderDialog.show({ query: "SELECT * FROM penguins", theme: "dark" });

    const dataset = document.querySelector<HTMLInputElement>(".embed-builder__input")!;
    dataset.value = "https://x.org/penguins.parquet";
    dataset.dispatchEvent(new Event("input"));

    const outputs = document.querySelectorAll<HTMLTextAreaElement>(".embed-builder__output-text");
    const [urlOut, iframeOut] = outputs;
    expect(urlOut.value).toContain("https://bedeverewise.app/embed#");
    expect(urlOut.value).toContain("dataset=https"); // URLSearchParams keeps ':' '/' literal
    expect(urlOut.value).toContain("theme=dark");
    expect(urlOut.value).toContain("autorun=1");
    expect(iframeOut.value).toContain("<iframe");
  });
});
