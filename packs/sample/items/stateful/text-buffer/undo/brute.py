class TextBuffer:
    def __init__(self):
        self.history = [""]

    def insert(self, text):
        self.history.append(self.history[-1] + text)

    def delete(self, count):
        content = self.history[-1]
        for _ in range(count):
            content = content[:-1]
        self.history.append(content)

    def text(self):
        return self.history[-1]

    def undo(self):
        if len(self.history) > 1:
            self.history.pop()
