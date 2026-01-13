export interface Question {
  id: string;
  text: string;
  category: string;
  isFollowUp?: boolean;
}

export interface Answer {
  questionId: string;
  text: string;
  timestamp: number;
}

export interface JobRequirement {
  position?: string;
  background?: string;
  mission?: string;
  responsibilities?: string[];
  mustHave?: string[];
  niceToHave?: string[];
  idealPerson?: string;
  location?: string;
  workStyle?: string;
  workingHours?: string;
  salary?: string;
  employmentType?: string;
  selectionProcess?: string;
  startDate?: string;
  ngConditions?: string;
  additionalInfo?: string;
}
