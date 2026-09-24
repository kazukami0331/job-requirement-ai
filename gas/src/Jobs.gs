/**
 * 対象求人の定義。
 * 3求人はいずれも「Winスクール 京都駅前校 / 業務委託 パソコンスクール講師」で、
 * 対象となる専門分野・ツールだけが異なる。
 * 求人票を追加・変更したらこのファイルだけを直せばよい。
 */
var JOBS = [
  {
    id: 'cad',
    name: 'CAD講師',
    title: '[業務委託] パソコンスクール講師（CAD）',
    fields: ['CAD分野'],
    tools: ['AutoCAD', 'Jw_cad', 'Vectorworks', 'Revit', 'SolidWorks', 'CATIA'],
    // 対象ツールそのものではないが近接する経験。△ の材料になる。
    adjacent: [
      'Fusion 360', 'Inventor', 'NX', 'Creo', 'ARCHICAD', 'Tfas', 'CADWe\'ll',
      'BIM', '機械設計', '建築設計', '電気設計', '施工図', '製図'
    ]
  },
  {
    id: 'web',
    name: 'Webデザイン講師',
    title: '[業務委託] パソコンスクール講師（WEB・デザイン・映像）',
    fields: ['WEB・デザイン・映像分野'],
    tools: ['Illustrator', 'Photoshop', 'HTML/CSS', 'JavaScript', 'Premiere Pro'],
    adjacent: [
      'InDesign', 'After Effects', 'XD', 'Figma', 'Dreamweaver', 'WordPress',
      'DTP', 'グラフィックデザイン', '動画編集', 'Webディレクション'
    ]
  },
  {
    id: 'it',
    name: 'プログラミング（IT）講師',
    title: '[業務委託] パソコンスクール講師（IT・プログラミング／DX・データ分析）',
    fields: ['IT・プログラミング・インフラ分野', 'DX・データ分析分野'],
    tools: [
      'Java', 'Python', 'C言語', 'SQL', 'ネットワーク', 'Linux', 'AWS',
      'Power BI', 'Power Automate', 'Excel VBA'
    ],
    adjacent: [
      'C#', 'C++', 'PHP', 'Ruby', 'Go', 'TypeScript', 'Oracle', 'MySQL',
      'Azure', 'GCP', 'Windows Server', 'インフラ構築', 'データ分析', 'RPA', 'Access'
    ]
  }
];

/** 求人IDから求人定義を引く。該当なしは null。 */
function findJob(jobId) {
  for (var i = 0; i < JOBS.length; i++) {
    if (JOBS[i].id === jobId) return JOBS[i];
  }
  return null;
}

/** 求人IDから表示名を返す。'none' / 未知のIDは「該当なし」。 */
function jobLabel(jobId) {
  var job = findJob(jobId);
  return job ? job.name : '該当なし';
}

/** プロンプトに埋め込む求人要件のテキスト。 */
function jobsAsPromptText() {
  var lines = [];
  for (var i = 0; i < JOBS.length; i++) {
    var job = JOBS[i];
    lines.push('### ' + job.id + '：' + job.name);
    lines.push('求人名：' + job.title);
    lines.push('対象分野：' + job.fields.join(' / '));
    lines.push('対象ツール：' + job.tools.join(' / '));
    lines.push('');
  }
  return lines.join('\n').trim();
}
