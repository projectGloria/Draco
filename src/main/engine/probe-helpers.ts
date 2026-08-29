export function isEmptyRangeResponse(status: number, contentRange: string | null): boolean {
  return status === 416 && /^bytes\s+\*\/0$/i.test(contentRange ?? '')
}
