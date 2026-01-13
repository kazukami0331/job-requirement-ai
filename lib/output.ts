import { JobRequirement, Answer, Question } from "@/types";

export function generateJobRequirement(
  answers: Answer[],
  questions: Question[]
): JobRequirement {
  const requirement: JobRequirement = {};

  answers.forEach((answer) => {
    const question = questions.find((q) => q.id === answer.questionId);
    if (!question) return;

    const cleanId = answer.questionId.replace("_followup", "");

    switch (cleanId) {
      case "position":
        requirement.position = answer.text;
        break;
      case "background":
        requirement.background = answer.text;
        break;
      case "mission":
        requirement.mission = answer.text;
        break;
      case "responsibilities":
        requirement.responsibilities = answer.text
          .split(/[、。\n]/)
          .filter((item) => item.trim().length > 0)
          .map((item) => item.trim());
        break;
      case "mustHave":
        requirement.mustHave = answer.text
          .split(/[、。\n]/)
          .filter((item) => item.trim().length > 0)
          .map((item) => item.trim());
        break;
      case "niceToHave":
        requirement.niceToHave = answer.text
          .split(/[、。\n]/)
          .filter((item) => item.trim().length > 0)
          .map((item) => item.trim());
        break;
      case "idealPerson":
        requirement.idealPerson = answer.text;
        break;
      case "location":
        requirement.location = answer.text;
        break;
      case "workingHours":
        requirement.workingHours = answer.text;
        break;
      case "salary":
        requirement.salary = answer.text;
        break;
      case "selectionProcess":
        requirement.selectionProcess = answer.text;
        break;
      case "startDate":
        requirement.startDate = answer.text;
        break;
      case "ngConditions":
        requirement.ngConditions = answer.text;
        break;
      case "additionalInfo":
        requirement.additionalInfo = answer.text;
        break;
    }
  });

  return requirement;
}

export function formatJobRequirement(requirement: JobRequirement): string {
  let output = "";

  if (requirement.position) {
    output += `【${requirement.position}】\n\n`;
  }

  if (requirement.background) {
    output += `## 採用背景\n${requirement.background}\n\n`;
  }

  if (requirement.mission) {
    output += `## ミッション・役割\n${requirement.mission}\n\n`;
  }

  if (requirement.responsibilities && requirement.responsibilities.length > 0) {
    output += `## 業務内容\n`;
    requirement.responsibilities.forEach((item) => {
      output += `・${item}\n`;
    });
    output += "\n";
  }

  if (requirement.mustHave && requirement.mustHave.length > 0) {
    output += `## 必須要件\n`;
    requirement.mustHave.forEach((item) => {
      output += `・${item}\n`;
    });
    output += "\n";
  }

  if (requirement.niceToHave && requirement.niceToHave.length > 0) {
    output += `## 歓迎要件\n`;
    requirement.niceToHave.forEach((item) => {
      output += `・${item}\n`;
    });
    output += "\n";
  }

  if (requirement.idealPerson) {
    output += `## 求める人物像\n${requirement.idealPerson}\n\n`;
  }

  if (requirement.location) {
    output += `## 勤務地・働き方\n${requirement.location}\n\n`;
  }

  if (requirement.workingHours) {
    output += `## 勤務時間\n${requirement.workingHours}\n\n`;
  }

  if (requirement.salary) {
    output += `## 年収・雇用形態\n${requirement.salary}\n\n`;
  }

  if (requirement.selectionProcess) {
    output += `## 選考プロセス\n${requirement.selectionProcess}\n\n`;
  }

  if (requirement.startDate) {
    output += `## 入社時期\n${requirement.startDate}\n\n`;
  }

  if (requirement.ngConditions) {
    output += `## 避けたいミスマッチ・NG条件\n${requirement.ngConditions}\n\n`;
  }

  if (requirement.additionalInfo) {
    output += `## その他・魅力ポイント\n${requirement.additionalInfo}\n\n`;
  }

  return output.trim();
}
