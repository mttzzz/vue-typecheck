<script setup lang="ts">
/* a
b */
const count = 1
const label: string = count
</script>

<template>
  <div title="a
b" />
  <div>{{ count.nope }}</div>
</template>
