"use client";

import { useState, useEffect, useRef } from "react";
import { Question, Answer } from "@/types";

interface ChatPanelProps {
  currentQuestion: Question;
  answers: Answer[];
  questions: Question[];
  onAnswer: (answer: string) => void;
  isComplete: boolean;
}

export default function ChatPanel({
  currentQuestion,
  answers,
  questions,
  onAnswer,
  isComplete,
}: ChatPanelProps) {
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [answers, currentQuestion]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isComplete) {
      onAnswer(inputValue);
      setInputValue("");
    }
  };

  const getQuestionById = (questionId: string) => {
    return questions.find((q) => q.id === questionId);
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6 flex flex-col h-[calc(100vh-200px)]">
      <div className="flex-1 overflow-y-auto mb-4 space-y-4">
        {answers.map((answer, index) => {
          const question = getQuestionById(answer.questionId);
          return (
            <div key={index} className="space-y-2">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                  <span className="text-white text-sm font-bold">AI</span>
                </div>
                <div className="flex-1 bg-blue-50 rounded-lg p-4">
                  <p className="text-gray-800">{question?.text}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 justify-end">
                <div className="flex-1 bg-gray-100 rounded-lg p-4 max-w-[80%] ml-auto">
                  <p className="text-gray-800">{answer.text}</p>
                </div>
                <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0">
                  <span className="text-gray-600 text-sm font-bold">You</span>
                </div>
              </div>
            </div>
          );
        })}
        {!isComplete && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-sm font-bold">AI</span>
            </div>
            <div className="flex-1 bg-blue-50 rounded-lg p-4">
              <p className="text-gray-800">{currentQuestion.text}</p>
            </div>
          </div>
        )}
        {isComplete && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-sm font-bold">✓</span>
            </div>
            <div className="flex-1 bg-green-50 rounded-lg p-4">
              <p className="text-gray-800 font-semibold">
                ありがとうございました！右側のアウトプット画面で求人要件を確認・編集できます。
              </p>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!isComplete && (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="回答を入力してください..."
            className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            autoFocus
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-semibold"
          >
            送信
          </button>
        </form>
      )}
    </div>
  );
}
