import { render } from 'solid-js/web'
import './activity.ts'
import { App } from './App.tsx'
import { Crashes } from './crashes.tsx'
import './index.css'
import { PowerMode } from './powerMode.tsx'

render(() => <App />, document.getElementById('root')!)
// Its own root, so it still shows when what broke is the app.
render(() => <Crashes />, document.body.appendChild(document.createElement('div')))
// Outside the app, so its shaking the app doesn't shake the sparks too.
render(() => <PowerMode />, document.body.appendChild(document.createElement('div')))
