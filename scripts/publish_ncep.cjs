/* Called by actions/github-script. Only compact public JSON enters this branch. */
module.exports = async function publish({github, context, directory = '.generated-ensembles'}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const {owner, repo} = context.repo;
  const branch = 'ensemble-track-data';
  let parent, baseTree, oldTree = [];
  try {
    parent = (await github.rest.git.getRef({owner,repo,ref:'heads/'+branch})).data.object.sha;
    baseTree = (await github.rest.git.getCommit({owner,repo,commit_sha:parent})).data.tree.sha;
    oldTree = (await github.rest.git.getTree({owner,repo,tree_sha:baseTree})).data.tree;
  } catch (error) { if(error.status !== 404) throw error; }
  const changes = [];
  const fresh = [];
  for(const model of ['GEFS','AIGEFS']) {
    const alias = model+'.json';
    const file = path.join(directory,alias);
    if(!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file,'utf8');
    const value = JSON.parse(content);
    if(value.schema!==1 || value.generator!=='ncep-hybrid-v1' || value.model!==model || value.ensembleSize!==31 || !/^20\d{2}-\d\d-\d\dT(?:00|06|12|18):00:00Z$/.test(value.run) || !value.tracks.length || Buffer.byteLength(content)>16_000_000) throw Error('Invalid compact NCEP publication');
    let previous;
    try {
      const previousBlob = oldTree.find(f=>f.path===alias)?.sha;
      if(previousBlob) {
        const remote = (await github.rest.git.getBlob({owner,repo,file_sha:previousBlob})).data;
        previous = JSON.parse(Buffer.from(remote.content,'base64').toString('utf8'));
      }
    } catch (error) { if(error.status!==404) throw error; }
    if(previous && (previous.run>value.run || previous.run===value.run && (previous.derived.fields>value.derived.fields || ['tracker','genesis'].some(kind=>previous.members.filter(m=>m[kind]==='available').length>value.members.filter(m=>m[kind]==='available').length)))) {
      console.log(model+': preserve newer/more complete same-cycle publication; no regression');
      continue;
    }
    const dated = model+'-'+value.run.replaceAll('-','').replaceAll(':','')+'.json';
    const blob = (await github.rest.git.createBlob({owner,repo,content,encoding:'utf-8'})).data.sha;
    for(const filename of [alias,dated]) changes.push({path:filename,mode:'100644',type:'blob',sha:blob});
    fresh.push({model,run:value.run,dated});
  }
  if(!changes.length) { console.log('No newer usable NCEP publication; existing JSON unchanged'); return; }
  // Keep three genuine distinct bases/model. Never delete the other model's alias.
  for(const {model,dated} of fresh) {
    const datedPattern = new RegExp('^'+model+'-20\\d{6}T(?:00|06|12|18)0000Z\\.json$');
    const all = [...new Set([dated,...oldTree.filter(f=>datedPattern.test(f.path)).map(f=>f.path)])].sort().reverse();
    for(const filename of all.slice(3)) changes.push({path:filename,mode:'100644',type:'blob',sha:null});
  }
  const tree = (await github.rest.git.createTree({owner,repo,...(baseTree?{base_tree:baseTree}:{}),tree:changes})).data.sha;
  const commit = (await github.rest.git.createCommit({owner,repo,message:'Publish native NCEP 31-member trackers and disclosed field-low coverage',tree,parents:parent?[parent]:[]})).data.sha;
  if(parent) await github.rest.git.updateRef({owner,repo,ref:'heads/'+branch,sha:commit,force:false});
  else await github.rest.git.createRef({owner,repo,ref:'refs/heads/'+branch,sha:commit});
  console.log('Published compact NCEP JSON: '+fresh.map(v=>v.model+' '+v.run).join(', '));
};
