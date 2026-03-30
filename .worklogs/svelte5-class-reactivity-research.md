# Svelte 5 Class Reactivity Research

## Key Findings from Official Docs

### 1. $state and $derived WORK in class fields
The Svelte 5 docs explicitly say "you can mark class fields as $derived". Our pattern SHOULD work:
```js
class Store {
  messages = $state([]);
  activeMessages = $derived(this.messages.filter(...));
}
```

### 2. $state arrays are deeply reactive proxies
From the docs: "$state transforms objects and arrays into deeply reactive proxies". This means `.push()` SHOULD trigger $derived recalculation.

### 3. Immutable reassignment also works
`this.messages = [...this.messages, newMsg]` should definitely trigger reactivity.

## Possible Root Causes

### Theory 1: The `$derived` captures a stale `this` reference
If `$derived` is evaluated at class field initialization time, `this` might be the prototype, not the instance. The derivation function might be reading a DIFFERENT `this.messages` than the one being mutated.

**Test:** Use `$derived.by(() => this.messages.filter(...))` — the `.by()` form explicitly wraps in a function and may handle `this` differently.

### Theory 2: async connect() breaks the reactive context
Our `connect()` method is async. If `this.messages = [...]` is called inside an async callback (the MQTT `on('message')` handler), it might be outside Svelte's reactive tracking context.

**Test:** Wrap the mutation in `$effect` or use `tick()`.

### Theory 3: The component doesn't re-render because props are stale
Even if `store.activeMessages` updates, the component might hold a stale reference. In Svelte 5, passing a class instance as a prop means the component gets the INSTANCE — but does it track changes to derived fields?

**Test:** In ChatView, instead of receiving `messages` as a prop, access `store.activeMessages` directly.

### Theory 4: File extension / compilation
The file MUST be `.svelte.js` for runes to work. We have this. But verify the Svelte compiler is actually processing it as a runes file.

## Recommended Fix Attempt Order

1. Change `$derived(...)` to `$derived.by(() => ...)` for activeMessages
2. If that doesn't work, try accessing store directly in ChatView instead of via props
3. If that doesn't work, check if the async connect callback is the issue
