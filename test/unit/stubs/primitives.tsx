/**
 * A stand-in for the shared component library.
 *
 * The Harness module loader supplies the real library to the browser bundle, so it
 * is not a dependency of this package and Vite cannot resolve it. The alias in
 * `vitest.config.ts` points the import here, and these plain elements forward the
 * props the page passes — which is exactly what the page's own tests need to see.
 */
import React from 'react'

export function Button(props: any) {
  return <button type="button" {...props}>{props.icon ?? null}{props.children}</button>
}

export function Checkbox(props: any) {
  return (
    <label>
      <input
        type="checkbox"
        checked={props.checked === true}
        disabled={props.disabled === true}
        title={props.title}
        onChange={(event) => props.onChange?.(event.target.checked)}
      />
      {props.label ?? null}
    </label>
  )
}

export function IconChevronDownOutlineRegular() {
  return <span data-icon="chevron" />
}

export function Input(props: any) {
  return (
    <span className={props.className}>
      <input
        value={props.value ?? ''}
        type={props.type}
        placeholder={props.placeholder}
        disabled={props.disabled === true}
        style={props.style}
        onChange={(event) => props.onChange?.(event)}
      />
    </span>
  )
}

export function Menu(props: any) {
  return (
    <span>
      {props.anchor}
      {props.open
        ? (
          <span role="menu">
            {(props.items ?? []).map((item: { id: string; label: string }) => (
              <button key={item.id} type="button" role="menuitem" onClick={() => props.onSelect?.(item.id)}>
                {item.label}
              </button>
            ))}
          </span>
        )
        : null}
    </span>
  )
}

export function Pill(props: any) {
  return <span data-pill="">{props.children}</span>
}

export function StateDot(props: any) {
  return <span data-state={props.state} />
}

export function Switch(props: any) {
  return (
    <input
      type="checkbox"
      checked={props.checked === true}
      onChange={(event) => props.onChange?.(event.target.checked)}
    />
  )
}
