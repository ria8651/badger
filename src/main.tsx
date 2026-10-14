import { render } from 'solid-js/web'
import { App } from './App.tsx'
import { Crashes } from './crashes.tsx'
import './index.css'

render(() => <App />, document.getElementById('root')!)
// Its own root, so it still shows when what broke is the app.
render(() => <Crashes />, document.body.appendChild(document.createElement('div')))
