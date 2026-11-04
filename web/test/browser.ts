import { readFileSync } from "node:fs"
import { Window } from "happy-dom"

const pageHtml = {
  index: readFileSync(new URL("../../dist/index.html", import.meta.url), "utf8"),
  measurement: readFileSync(new URL("../../dist/measurement/index.html", import.meta.url), "utf8"),
}

export interface BrowserPage {
  window: Window
  document: Document
  fetchCalls: { url: string; init: RequestInit }[]
  setFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void
  fire(element: Element, type: string): void
  setConfirm(handler: (message?: string) => boolean): void
  close(): Promise<void>
}

// The smoke tests render the real static pages produced by `pnpm build` into a
// lightweight browser DOM, disable external script/CSS loading, and drive the
// controllers with mocked same-origin APIs. No real service is contacted.
export function openPage(page: "index" | "measurement" = "index"): BrowserPage {
  const window = new Window({
    url: page === "measurement" ? "http://127.0.0.1:8790/measurement" : "http://127.0.0.1:8790/",
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableComputedStyleRendering: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  })
  window.document.write(pageHtml[page])
  const document = window.document as unknown as Document
  const fetchCalls: { url: string; init: RequestInit }[] = []
  let fetchHandler: (url: string, init: RequestInit) => Promise<Response> | Response = () => {
    throw new Error("Unexpected fetch in browser smoke test.")
  }

  Object.assign(globalThis, {
    window,
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLDialogElement: window.HTMLDialogElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    SVGCircleElement: window.SVGCircleElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    Blob: window.Blob,
    URL: window.URL,
  })

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const requestInit = init ?? {}
    fetchCalls.push({ url, init: requestInit })
    return Promise.resolve(fetchHandler(url, requestInit))
  }) as typeof fetch

  return {
    window,
    document,
    fetchCalls,
    setFetch(handler) { fetchHandler = handler },
    fire(element, type) {
      element.dispatchEvent(new window.Event(type, { bubbles: true }) as unknown as Event)
    },
    setConfirm(handler) { Object.defineProperty(window, "confirm", { value: handler, configurable: true }) },
    async close() { await window.happyDOM.close() },
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}
