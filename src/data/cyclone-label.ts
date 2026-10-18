// Display only. Never use this label for association, storage, URLs or exported source IDs.
export function cycloneLabel(id:string){
 const m=/^(WP|EP|CP|AL|SP|SI)(\d{2})(20\d{2})$/.exec(id)
 if(!m)return id
 const suffix:Record<string,string>={WP:'W',EP:'E',CP:'C',AL:'L',SP:'P',SI:'S'}
 return `${m[2]}${suffix[m[1]!]} · ${id}`
}
