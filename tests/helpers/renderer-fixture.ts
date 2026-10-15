import { build } from 'esbuild'

// Execute the real component command callbacks without an Electron window.
// Only React's rendering machinery is replaced; stores and IPC calls are real
// production code. Each instance keeps hook state and effect cleanup separate.
const hooks = `
let current;
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
export function createRenderer() {
  const renderer = { slots: [], index: 0, effects: [],
    render(component, props) { current = renderer; renderer.index = 0; try { return component(props); } finally { current = null; } },
    flushEffects() { for (const effect of renderer.effects.splice(0)) effect(); },
    cleanup() { for (const slot of renderer.slots) slot?.cleanup?.(); }
  };
  return renderer;
}
export function useState(initial) {
  const renderer = current, i = renderer.index++;
  if (!renderer.slots[i]) renderer.slots[i] = { value: typeof initial === 'function' ? initial() : initial };
  return [renderer.slots[i].value, next => { const slot = renderer.slots[i]; slot.value = typeof next === 'function' ? next(slot.value) : next; }];
}
export function useRef(value) {
  const i = current.index++;
  return current.slots[i] ??= { current: value };
}
export function useMemo(factory, deps) {
  const i = current.index++, slot = current.slots[i];
  if (!slot || !same(slot.deps, deps)) current.slots[i] = { value: factory(), deps };
  return current.slots[i].value;
}
export function useCallback(fn, deps) { return useMemo(() => fn, deps); }
export function useEffect(fn, deps) {
  const renderer = current, i = renderer.index++, slot = renderer.slots[i];
  if (!slot || !same(slot.deps, deps)) {
    const next = { deps, cleanup: slot?.cleanup };
    renderer.slots[i] = next;
    renderer.effects.push(() => { next.cleanup?.(); next.cleanup = fn(); });
  }
}
export const useLayoutEffect = useEffect;
export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
export const useDebugValue = () => {};
export const memo = component => component;
export class Component {}
export default { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore, useDebugValue, memo, Component };
`
const jsx = `export const Fragment = Symbol.for('fixture.fragment');
export const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
export const jsxs = jsx;
export const jsxDEV = jsx;`

export async function rendererFixture(contents: string): Promise<any> {
  const bundle = await build({
    stdin: { contents: `${contents}\nexport { createRenderer } from 'react'`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: 'tsconfig.web.json',
    loader: { '.png': 'dataurl', '.webp': 'dataurl', '.ico': 'dataurl', '.wav': 'dataurl' },
    plugins: [{ name: 'component-hooks', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx(?:-dev)?-runtime)?$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
      builder.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
        contents: args.path === 'react' ? hooks : args.path === 'react-dom'
          ? 'export const createPortal = children => children;' : jsx,
        loader: 'js'
      }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}

export function elements(node: any): any[] {
  if (node == null || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(elements)
  if (typeof node !== 'object') return []
  return [node, ...elements(node.props?.children), ...elements(node.props?.footer)]
}

export function content(node: any): string {
  if (node == null || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(content).join('')
  if (typeof node === 'object') return content(node.props?.children)
  return String(node)
}

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
