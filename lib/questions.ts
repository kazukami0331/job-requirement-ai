import { Question } from "@/types";

export const initialQuestions: Question[] = [
  {
    id: "position",
    text: "どんなポジションを採用したいですか？職種や役割を教えてください。",
    category: "基本情報",
  },
  {
    id: "background",
    text: "採用の背景を教えてください。増員、欠員、新規事業など、どんな理由で採用したいですか？",
    category: "採用背景",
  },
  {
    id: "mission",
    text: "このポジションのミッションや期待する役割を教えてください。",
    category: "ミッション",
  },
  {
    id: "responsibilities",
    text: "主な業務内容を教えてください。3〜5個くらいで大丈夫です。",
    category: "業務内容",
  },
  {
    id: "mustHave",
    text: "必須のスキルや経験を教えてください。年数や規模感があればそれも教えてください。",
    category: "必須要件",
  },
  {
    id: "niceToHave",
    text: "あれば嬉しいスキルや経験はありますか？",
    category: "歓迎要件",
  },
  {
    id: "idealPerson",
    text: "どんな人物像を求めていますか？性格や働き方のスタイルなど、カルチャーフィットする人材の特徴を教えてください。",
    category: "人物像",
  },
  {
    id: "location",
    text: "勤務地と働き方について教えてください。リモート可か、出社頻度など。",
    category: "勤務地・働き方",
  },
  {
    id: "workingHours",
    text: "勤務時間やフレックス、裁量労働制などについて教えてください。",
    category: "勤務時間",
  },
  {
    id: "salary",
    text: "想定年収や雇用形態（正社員、契約社員など）を教えてください。",
    category: "待遇",
  },
  {
    id: "selectionProcess",
    text: "選考プロセスを教えてください。面接回数や課題の有無、想定期間など。",
    category: "選考",
  },
  {
    id: "startDate",
    text: "入社時期の希望はありますか？",
    category: "入社時期",
  },
  {
    id: "ngConditions",
    text: "避けたいミスマッチやNG条件があれば教えてください。",
    category: "NG条件",
  },
  {
    id: "additionalInfo",
    text: "その他、伝えたい魅力や補足情報があれば教えてください。",
    category: "補足",
  },
];

export function getFollowUpQuestion(questionId: string, answer: string): Question | null {
  // 回答が短すぎる場合や曖昧な場合に追質問を生成
  if (answer.length < 20) {
    const question = initialQuestions.find((q) => q.id === questionId);
    if (question) {
      return {
        id: `${questionId}_followup`,
        text: "もう少し詳しく教えてもらえますか？具体例があると助かります。",
        category: question.category,
        isFollowUp: true,
      };
    }
  }
  return null;
}
