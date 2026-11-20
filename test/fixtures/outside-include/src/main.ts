import { createApp } from 'vue'

import { Deep } from '../widgets/index'
import App from './App.vue'

createApp(App).component('Deep', Deep).mount('#app')
