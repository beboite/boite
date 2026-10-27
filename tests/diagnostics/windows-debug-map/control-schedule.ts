/** The caller retains capture errors and owns final registry cleanup. */
export async function runControlBatches(background:readonly Promise<unknown>[],batches:readonly (()=>Promise<void>)[]):Promise<PromiseSettledResult<void>[]> {
 await Promise.allSettled(background);
 const results:PromiseSettledResult<void>[]=[];
 for(const start of batches)results.push(...await Promise.allSettled([Promise.resolve().then(start)]));
 return results;
}
