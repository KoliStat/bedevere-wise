import { ICellSelection } from "../SpreadsheetVisualizer";

function downloadFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the click has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const exportAsText = async (
  selection: ICellSelection,
  includeHeader: boolean,
  includeIndex: boolean,
  separator: string = ",",
  eol: string = "\n",
  datasetName: string = "export",
  quoteEscape: "double" | "backslash" = "double",
) => {
  const { rows, columns, formatted } = selection;

  const headers = columns.map((column) => column.name);
  if (includeIndex) {
    headers.unshift("Index");
  }

  // Add the header if requested
  const csvContent: string[] = [];
  if (includeHeader) {
    csvContent.push(headers.join(separator));
  }

  // Add the rows
  csvContent.push(
    ...formatted.map((row, i) => {
      const val = includeIndex ? `${rows[i]}${separator}` : "";
      return (
        val +
        row
          .map((formattedCell) => {
            // Escape quotes and wrap in quotes if contains comma, quote, or newline
            if (formattedCell.includes(separator) || formattedCell.includes('"') || formattedCell.includes(eol)) {
              const escaped = quoteEscape === "backslash"
                ? formattedCell.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                : formattedCell.replace(/"/g, '""');
              return `"${escaped}"`;
            }
            return formattedCell;
          })
          .join(separator)
      );
    })
  );

  const text = csvContent.join(eol);
  const ext = separator === "\t" ? "tsv" : "csv";
  const mime = separator === "\t" ? "text/tab-separated-values" : "text/csv";

  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("Failed to copy text to clipboard:", err);
  }
  downloadFile(text, `${datasetName}.${ext}`, mime);
};

export const exportAsHTML = async (
  selection: ICellSelection,
  includeHeader: boolean,
  includeIndex: boolean,
  datasetName: string = "export"
) => {
  const { rows, columns, formatted } = selection;

  const headers = columns.map((column) => column.name);
  if (includeIndex) {
    headers.unshift("Index");
  }

  const header = headers.map((header) => `<th style="background-color: #f2f2f2; padding: 8px; text-align: left;">${header}</th>`).join("");
  const thead = `<thead><tr>${header}</tr></thead>`;

  // Create HTML table
  const htmlContent = `
    <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; font-family: Arial, sans-serif;">
      ${includeHeader ? thead : ""}
      <tbody>
        ${formatted
          .map((row, i) => {
            const val = includeIndex ? `<td>${rows[i]}</td>` : "";
            return `<tr>${val}${row.map((cell) => `<td style="padding: 8px;">${cell}</td>`).join("")}</tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  try {
    await navigator.clipboard.writeText(htmlContent);
  } catch (err) {
    console.error("Failed to copy HTML to clipboard:", err);
  }
  downloadFile(htmlContent, `${datasetName}.html`, "text/html");
};

export const exportAsMarkdown = async (
  selection: ICellSelection,
  _: boolean,
  includeIndex: boolean,
  eol: string = "\n",
  datasetName: string = "export"
) => {
  const { rows, columns, formatted } = selection;

  const headers = columns.map((column) => column.name);
  if (includeIndex) {
    headers.unshift("Index");
  }

  // Create markdown table
  const markdownContent = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...formatted.map((row, i) => {
      const val = includeIndex ? `${rows[i]} | ` : "";
      return `| ${val}${row.map((cell) => cell).join(" | ")} |`;
    }),
  ].join(eol);

  try {
    await navigator.clipboard.writeText(markdownContent);
  } catch (err) {
    console.error("Failed to copy Markdown to clipboard:", err);
  }
  downloadFile(markdownContent, `${datasetName}.md`, "text/markdown");
};
