<script setup lang="ts">
import Inner from './Inner.vue'

defineProps<{ count: number }>()
const label: string = 1
</script>

<template>
  <Inner />
  <p>{{ label }}</p>
</template>
