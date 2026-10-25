<script>
  import { createEventDispatcher } from 'svelte';
  export let label;
  export let items = [];
  export let value = '';
  export let placeholder = 'Search';
  export let required = false;
  const dispatch = createEventDispatcher();
  let open = false;

  $: query = value.trim().toLocaleLowerCase();
  $: matches = items.filter((item) => item.name.toLocaleLowerCase().includes(query)).sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(query)) - Number(a.name.toLocaleLowerCase().startsWith(query)) || a.name.localeCompare(b.name)).slice(0, 10);

  function choose(item) {
    value = item.name;
    open = false;
    dispatch('change', { value });
  }
</script>

<label class="picker">
  {#if label}<span>{label}</span>{/if}
  <span class="picker-control">
    <input bind:value {placeholder} {required} autocomplete="off" on:focus={() => open = true} on:input={() => open = true} on:keydown={(event) => event.key === 'Escape' && (open = false)} on:blur={() => setTimeout(() => open = false, 150)} />
    {#if open}
      <span class="picker-menu" role="listbox">
        {#each matches as item}
          <button type="button" on:mousedown|preventDefault on:click={() => choose(item)}>{item.name}</button>
        {:else}
          <span class="muted">No matches</span>
        {/each}
      </span>
    {/if}
  </span>
</label>
