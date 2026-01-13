"use client";

import { useState, useEffect, useRef } from "react";
import { Question, Answer, JobRequirement } from "@/types";
import { initialQuestions, getFollowUpQuestion } from "@/lib/questions";
import { generateJobRequirement, formatJobRequirement } from "@/lib/output";
import ChatPanel from "@/components/ChatPanel";
import OutputPanel from "@/components/OutputPanel";

export default function Home() {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [outputText, setOutputText] = useState<string>("");
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (answers.length > 0) {
      const requirement = generateJobRequirement(answers, questions);
      const formatted = formatJobRequirement(requirement);
      setOutputText(formatted);
    }
  }, [answers, questions]);

  const handleAnswer = (answerText: string) => {
    if (!answerText.trim()) return;

    const currentQuestion = questions[currentQuestionIndex];
    const newAnswer: Answer = {
      questionId: currentQuestion.id,
      text: answerText,
      timestamp: Date.now(),
    };

    const updatedAnswers = [...answers, newAnswer];
    setAnswers(updatedAnswers);

    // 追質問のチェック
    const followUp = getFollowUpQuestion(currentQuestion.id, answerText);
    if (followUp && !currentQuestion.isFollowUp) {
      // 追質問を追加
      const updatedQuestions = [...questions];
      updatedQuestions.splice(currentQuestionIndex + 1, 0, followUp);
      setQuestions(updatedQuestions);
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      // 次の質問へ
      if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
      } else {
        setIsComplete(true);
      }
    }
  };

  const handleOutputChange = (text: string) => {
    setOutputText(text);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      <div className="container mx-auto px-4 py-8">
        <header className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            求人要件ヒアリングAI
          </h1>
          <p className="text-gray-600">
            AIの質問に答えるだけで、求人要件を言語化できます
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChatPanel
            currentQuestion={questions[currentQuestionIndex]}
            answers={answers}
            questions={questions}
            onAnswer={handleAnswer}
            isComplete={isComplete}
          />
          <OutputPanel
            outputText={outputText}
            onOutputChange={handleOutputChange}
            isComplete={isComplete}
          />
        </div>
      </div>
    </div>
  );
}
