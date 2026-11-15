import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pool} from '../src/db/pool';
import {readImportFolder,runImport,IMPORT_FILES} from '../src/services/pdp/importService';
import {tikaCompanyKey} from '../src/services/pdp/company';
import {getOverview,getRoadmap} from '../src/services/pdp/monitorService';
import {parseProductTree} from '../src/services/pdp/importParsers';
import {listProducts} from '../src/services/pdp/treeService';
async function main(){
 if(process.env.DB_HOST!=='127.0.0.1'||process.env.DB_PORT!=='33309')throw Error('Checkpoint runner requires the isolated local test MySQL on 127.0.0.1:33309.');
 const actor=Number(process.env.PDP_IMPORT_ACTOR);if(!actor)throw Error('PDP_IMPORT_ACTOR is required.');
 const files=await readImportFolder();if(Object.keys(files).length!==3)throw Error('All three source files are required.');
 const source=await parseProductTree(files.productTree!);
 const preview=await runImport(files,{commit:false,actorUserId:actor,sources:IMPORT_FILES});
 const committed=await runImport(files,{commit:true,actorUserId:actor,sources:IMPORT_FILES});
 const repeated=await runImport(files,{commit:true,actorUserId:actor,sources:IMPORT_FILES});
 if(Object.values(repeated.tables).some(c=>c.created||c.updated))throw Error('Idempotency failed');
 const ck=await tikaCompanyKey();const products=await listProducts(ck);
 const dateDifferences=source.rows.filter(r=>products.find(p=>p.name===r.name)?.planned_launch_date!==r.launchDate);
 if(dateDifferences.length)throw Error('Imported launch dates differ from source');
 const overview=await getOverview(ck,'2026-Q4',{userId:actor,roles:[]});const roadmap=await getRoadmap(ck);
 const [governance]=await pool.query('SELECT COUNT(*) AS n FROM pdp_governance_member WHERE deleted_at IS NULL');
 const result={database:{host:'127.0.0.1',port:33309,name:process.env.DB_NAME},date:'2026-11-14',preview,committed,repeated,verification:{unchangedLaunchDates:true,products:products.length,autoLinked:products.filter(p=>p.dim_product_key).length,governance,lateUnderDevelopment:overview.alerts.filter(a=>a.kind==='late_product').length,lateRoadmap:roadmap.items.filter(p=>p.late).length,approverWarnings:overview.alerts.filter(a=>a.kind==='no_approver').map(a=>a.message)}};
 const dir=path.resolve('../../Input/product_development');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'checkpoint-2.json'),JSON.stringify(result,null,2));
 const corrections=[...new Set(committed.corrections.map(c=>`${c.from} → ${c.to}`))];
 const md=['# Checkpoint 2 — test-stack import report','',`Date: 14 November 2026. Database: ${process.env.DB_NAME} at 127.0.0.1:33309 (07ps-test).`,'','The test database already contained the seed rows when this continuation began. The import was previewed, committed and committed again; existing rows were preserved. No production operation was performed.','','## Imported data',`- ${committed.tree.products} products; ${committed.tree.families} families; ${committed.tree.subfamilies} subfamilies.`,`- Statuses: ${JSON.stringify(committed.tree.byStatus)}.`,`- ${committed.tree.flexible} flexible launch dates; all source launch dates verified unchanged.`,`- Policy v1.0: ${committed.policy?.sections} sections.`,`- ${committed.unplaced.length} unplaced rows; ${committed.scoring.problems.length} scoring problems.`,`- ${result.verification.lateUnderDevelopment} overdue under-development alerts; ${result.verification.lateRoadmap} late roadmap markers.`,`- ${result.verification.autoLinked} Odoo links assigned; governance remains unassigned. Resetting seed data was not necessary.`, '', '## Import counts','| Table | Created | Updated | Skipped |','|---|---:|---:|---:|',...Object.entries(committed.tables).map(([name,c])=>`| ${name} | ${c.created} | ${c.updated} | ${c.skipped} |`),'','Repeat import: zero created and zero updated.','','## Corrections actually applied by the parsers',...corrections.map(c=>'- '+c),'','## Odoo suggestions — confirm manually in the app',...committed.odooMatches.map(m=>`- **${m.product}**: ${m.candidates.length?m.candidates.map(c=>`${c.name} [${c.code??c.ProductKey}; ${c.match}]`).join('; '):'No confident name match; use the product picker.'}`),'','## Missing approvers',...result.verification.approverWarnings.map(x=>'- '+x),'','Detailed cell-by-cell corrections and both import results are in checkpoint-2.json.'].join('\n');
 await writeFile(path.join(dir,'checkpoint-2.md'),md);console.log(JSON.stringify({report:path.join(dir,'checkpoint-2.md'),verification:result.verification,tree:committed.tree,counts:committed.tables,odooSuggestions:committed.odooMatches.length},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end());
