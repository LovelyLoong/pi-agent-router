export type RouterDiagnosticSeverity = "error" | "warning" | "info";

export interface RouterDiagnostic {
  code: string;
  severity: RouterDiagnosticSeverity;
  message: string;
  path?: string;
}
