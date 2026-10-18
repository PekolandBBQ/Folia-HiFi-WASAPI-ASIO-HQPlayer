import ForkUpdateDetails from '../../src/components/modal/settings/ForkUpdateDetails';
import type { ProbeDefinition } from './definition';
// dev/probes/forkUpdate.probe.tsx
const status={forkUpdate:true,autoUpdateSupported:false,downloadUrl:'https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/releases/download/test/app.zip',releaseNotes:'修复首次连接\n改善播放恢复',error:null} as ElectronUpdateStatus;
export default {id:'forkUpdate',title:'Fork update',description:'Portable download and release notes',Component:()=> <ForkUpdateDetails status={status}/>} satisfies ProbeDefinition;
