<script setup lang="ts">
import Counter from './Counter.vue'
</script>

<!-- A static prop value with `//` makes @vue/language-core 3.3.13 emit TypeScript that does not parse. -->
<template>
  <Counter :start="1" label="see https://example.com/a" />
</template>
