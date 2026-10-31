/**
 * Common English nicknames, one family per line, formal name first. Used to search for "Steve" when
 * the model only told us about "Stephen M. Smith". Kept conservative: a nickname that's mostly its own
 * name elsewhere (e.g. "May" for Mary) is left out, since it would make two different people look alike.
 */
const FAMILIES = `
william will bill billy willie liam
robert rob bob bobby robbie
richard rick ricky rich richie dick
james jim jimmy jamie
john johnny jack
joseph joe joey
thomas tom tommy
michael mike mikey mick
christopher chris
daniel dan danny
matthew matt matty
anthony tony
stephen steve stevie
steven steve stevie
edward ed eddie ted ned
charles charlie chuck
david dave davey
andrew andy drew
benjamin ben benny
samuel sam sammy
alexander alex
nicholas nick nicky
timothy tim timmy
gregory greg
kenneth ken kenny
ronald ron ronnie
donald don donnie
lawrence larry
gerald jerry
patrick pat
peter pete
raymond ray
frederick fred freddy
henry hank
harold hal
theodore ted teddy theo
jonathan jon
nathaniel nate nat
nathan nate
zachary zach zack
jacob jake
joshua josh
jeffrey jeff
douglas doug
phillip phil
philip phil
eugene gene
leonard len lenny
vincent vince vinny
francis frank frankie
albert al bert
alfred al alfie
elizabeth liz lizzie beth betty betsy eliza libby
margaret maggie meg peggy
katherine kate katie kathy
catherine cathy kate katie
kathleen kathy kate katie
jennifer jen jenny
jessica jess jessie
rebecca becky becca
susan sue susie
deborah deb debbie
patricia pat patty trish
barbara barb
dorothy dot dottie
victoria vicky tori
christine chris chrissy tina
christina chris tina
stephanie steph
samantha sam sammy
alexandra alex lexi
abigail abby
emily emmy em
emma emmy em
jacqueline jackie
judith judy
pamela pam
cynthia cindy
kimberly kim
melissa missy mel
amanda mandy
theresa terry tess
teresa terry tess
virginia ginny
caroline carrie
carolyn carrie
josephine jo josie
gabrielle gabby
gabriel gabe
isabella bella izzy
isabel bella izzy
madeline maddie
allison allie
eleanor ellie nell
`
  .trim()
  .split("\n")
  .map((line) => line.trim().split(/\s+/));

const byName = new Map<string, Set<string>>();
for (const family of FAMILIES) {
  for (const name of family) {
    const others = byName.get(name) ?? new Set<string>();
    for (const other of family) if (other !== name) others.add(other);
    byName.set(name, others);
  }
}

const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Other forms of a first name: "Stephen" → Steve, Stevie; "Bill" → William, Will, Billy, Willie, Liam. */
export function nicknamesFor(first: string): string[] {
  const others = byName.get(first.toLowerCase());
  if (!others) return [];
  const upper = first === first.toUpperCase() && first.length > 1;
  return [...others].map((n) => (upper ? n.toUpperCase() : titleCase(n)));
}
