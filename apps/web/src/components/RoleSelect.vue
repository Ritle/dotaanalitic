<script setup lang="ts">
import {nextTick} from 'vue';
import {roleName} from '../role-suggestions';
const props=defineProps<{modelValue:number;label:string;disabled?:boolean}>();
const emit=defineEmits<{'update:modelValue':[role:number]}>();
async function change(event:Event){
  const select=event.target as HTMLSelectElement;emit('update:modelValue',Number(select.value));await nextTick();
  // Restore the controlled value even if the parent rejects an invalid assignment.
  if(select.isConnected)select.value=String(props.modelValue);
}
</script>
<template>
  <label class="role-select">Роль игрока
    <select :value="modelValue" :aria-label="label" :disabled="disabled" @change="change">
      <option v-for="role in 5" :key="role" :value="role">{{role}}. {{roleName(role)}}</option>
    </select>
  </label>
</template>
<style scoped>.role-select{display:block;min-width:0}.role-select select{width:100%}</style>
