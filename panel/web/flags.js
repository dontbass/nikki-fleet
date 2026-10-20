// nikki-fleet panel: country flags for node names that have none.
// Many subscriptions name nodes "Netherlands-01" or "DE Frankfurt" without a
// flag emoji; the panel adds one so lists are easier to scan.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const FLAG_WORDS = [
  ["NL","netherlands|holland|amsterdam|нидерланд|голланд|амстердам"], ["DE","germany|german|frankfurt|berlin|munich|герман|франкфурт|берлин"],
  ["FI","finland|helsinki|финлянд|хельсинки"], ["SE","sweden|stockholm|швеци|стокгольм"], ["NO","norway|oslo|норвеги"],
  ["DK","denmark|copenhagen|дани"], ["RU","russia|moscow|saint.?petersburg|spb|msk|росси|москв|питер|петербург"],
  ["RO","romania|bucharest|румын"], ["FR","france|paris|франци|париж"], ["GB","great.?britain|united.?kingdom|england|london|британ|англи|лондон"],
  ["US","united.?states|usa|america|new.?york|nyc|los.?angeles|virginia|сша|америк|нью.?йорк|вирджини"], ["CA","canada|toronto|канад"],
  ["TR","turkey|türkiye|istanbul|турци|стамбул"], ["PL","poland|warsaw|польш|варшав"], ["KZ","kazakhstan|almaty|astana|казахст|алмат"],
  ["BY","belarus|minsk|беларус|белорус|минск"], ["IL","israel|tel.?aviv|израил"], ["AM","armenia|yerevan|армени|ереван"],
  ["LV","latvia|riga|латви|рига"], ["LT","lithuania|vilnius|литв|вильнюс"], ["EE","estonia|tallinn|эстони|таллин"],
  ["UA","ukraine|kyiv|kiev|украин|киев"], ["JP","japan|tokyo|япони|токио"], ["SG","singapore|сингапур"], ["HK","hong.?kong|гонконг"],
  ["IN","india|mumbai|индия|инди"], ["BR","brazil|sao.?paulo|бразили"], ["CZ","czech|prague|чехи|праг"], ["AT","austria|vienna|австри|вена"],
  ["CH","switzerland|zurich|швейцар|цюрих"], ["IT","italy|milan|rome|итали|милан"], ["ES","spain|madrid|испани|мадрид"],
  ["BG","bulgaria|sofia|болгари"], ["AL","albania|албани"], ["HU","hungary|budapest|венгри"], ["RS","serbia|belgrade|серби"],
  ["GE","georgia|tbilisi|грузи|тбилиси"], ["AE","emirates|uae|dubai|оаэ|дубай|эмират"], ["AU","australia|sydney|австрали"],
  ["MD","moldova|chisinau|молдов"], ["CY","cyprus|кипр"], ["GR","greece|athens|греци"], ["PT","portugal|lisbon|португал"],
  ["IE","ireland|dublin|ирланди"], ["BE","belgium|brussels|бельги"], ["IS","iceland|исланди"], ["KR","korea|seoul|коре"],
  ["VN","vietnam|вьетнам"], ["TH","thailand|bangkok|таиланд"], ["ID","indonesia|jakarta|индонези"], ["AR","argentina|аргентин"],
  ["MX","mexico|мексик"], ["ZA","south.?africa|юар"], ["LU","luxembourg|люксембург"], ["SK","slovakia|словаки"], ["SI","slovenia|словени"],
  ["HR","croatia|хорвати"], ["KG","kyrgyzstan|бишкек|киргиз"], ["UZ","uzbekistan|ташкент|узбекист"], ["AZ","azerbaijan|baku|азербайдж|баку"],
];
const FLAG_RE = FLAG_WORDS.map(([cc, w]) => [cc, new RegExp(`(^|[^\\p{L}])(${w})`, "iu")]);
// bare two-letter codes ("DE Frankfurt", "NL-01"); ambiguous ones (IN, IS, IT, ID, NO, BE, AM…) are left out
const FLAG_CODES = new Set("NL DE FI SE DK RU RO FR GB UK US CA TR PL KZ BY IL LV LT EE UA JP SG HK BR CZ AT CH ES BG HU RS GE AE AU MD CY GR PT IE KR VN TH MX LU SK KG UZ AZ".split(" "));
const HAS_FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}/u;
const flagOf = cc => String.fromCodePoint(...[...(cc === "UK" ? "GB" : cc)].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));

// Returns the flag emoji for a node name, or "" if it has one already or no country is recognized.
function guessFlag(name){
  name = String(name ?? "");
  if(!name || HAS_FLAG.test(name)) return "";
  for(const [cc, re] of FLAG_RE) if(re.test(name)) return flagOf(cc);
  const m = name.match(/(?:^|[^A-Za-z])([A-Z]{2})(?=[^A-Za-z]|$)/g);
  if(m) for(const t of m){ const cc = t.replace(/[^A-Z]/g, ""); if(FLAG_CODES.has(cc)) return flagOf(cc); }
  return "";
}
// Escaped name with a flag prefix when one is guessed.
function fname(name){ const f = guessFlag(name); return (f ? `<span class="flag">${f}</span> ` : "") + esc(name); }
