<script setup lang="ts">
import { reactive } from 'vue'

const state = reactive({ text: '' })
</script>

<!-- A `//` in the attribute of a plain element is fine; only component props hit the codegen bug (see SlashSlash.vue). -->
<template>
  <a href="https://example.com/a">link</a>
  <input v-model="state.text" placeholder="http://127.0.0.1:7890" />
</template>
