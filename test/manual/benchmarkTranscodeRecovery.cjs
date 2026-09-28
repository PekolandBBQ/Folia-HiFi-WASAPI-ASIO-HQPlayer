const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runProcess, encodeArgs, validateArgs } = require('../../electron/transcode/runner.cjs');

// test/manual/benchmarkTranscodeRecovery.cjs — same-byte sequential versus speculative parallel decoding.
async function main() {
    const root=path.resolve('test-results',`tolerant-benchmark-${Date.now()}`);await fs.mkdir(root,{recursive:true});
    const executable=path.resolve('build/ffmpeg/win-x64/ffmpeg.exe'), rows=[];
    for(const [song,inputPath] of [['Spica','D:/Music/QQMusic/HUMMING LIFE - Spica.flac'],['Sakurane','D:/Music/QQMusic/ピコ - 桜音.flac']]) {
        for(let round=0;round<3;round++)for(const parallel of round%2?[true,false]:[false,true]) {
            const start=performance.now();let strictMs=0,tolerantMs=0,validationMs=0;
            async function encode(tolerant) {
                const outputPath=path.join(root,`${song}-${round}-${parallel}-${tolerant}.flac`), began=performance.now();
                try {await runProcess({executable,args:encodeArgs(inputPath,outputPath,'flac',tolerant)});return outputPath;}
                finally {if(tolerant)tolerantMs=performance.now()-began;else strictMs=performance.now()-began;}
            }
            let outputPath;
            if(parallel) {const [strict,tolerant]=await Promise.allSettled([encode(false),encode(true)]);if(strict.status==='fulfilled')outputPath=strict.value;else if(tolerant.status==='fulfilled')outputPath=tolerant.value;else throw tolerant.reason;}
            else {try{outputPath=await encode(false);}catch{outputPath=await encode(true);}}
            const validationStart=performance.now();await runProcess({executable,args:validateArgs(outputPath)});validationMs=performance.now()-validationStart;
            const row={song,round,parallel,totalMs:performance.now()-start,strictMs,tolerantMs,validationMs,networkExcluded:true};rows.push(row);console.log(JSON.stringify(row));
        }
    }
    await fs.writeFile(path.join(root,'results.json'),JSON.stringify(rows,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
