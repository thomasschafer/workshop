class TextBuffer:
    def __init__(self):
        self.history = [""]
        self.future = []

    def insert(self, text):
        self.history.append(self.history[-1] + text)
        self.future = []

    def delete(self, count):
        content = self.history[-1]
        for _ in range(count):
            content = content[:-1]
        self.history.append(content)
        self.future = []

    def text(self):
        return self.history[-1]

    def undo(self):
        if len(self.history) > 1:
            self.future.append(self.history.pop())

    def redo(self):
        if self.future:
            self.history.append(self.future.pop())
